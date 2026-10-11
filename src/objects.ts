import { RoomEngine, DomainError } from './domain.ts';
import type { EngineData } from './domain.ts';
import {
  parseClientMessage,
  MAX_ATTACHMENT_BYTES,
  MAX_VOICE_DURATION_MS,
  MAX_CHAT_LENGTH,
} from '../protocol/index.ts';
import type {
  Profile,
  PublicRoom,
  ServerMessage,
  WatchRoomState,
  RoomAttachment,
  RoomAttachmentKind,
  RoomChatMessage,
} from '../protocol/index.ts';
import type { Env } from './worker.ts';
import { businessLog } from './logging.ts';
import {
  saveAttachment,
  loadAttachment,
  getUploadReceipt,
  cleanEvictedAttachments,
  eraseAllAttachmentData,
  sha256Hex,
  sniffMimeType,
  type StoredAttachmentMeta,
} from './attachments.ts';

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
type Attachment = {
  profileId: number;
  connectionId: string;
  window: number;
  messages: number;
  lastSeen: number;
  chatWindow?: number;
  chatCount?: number;
  reactionWindow?: number;
  reactionCount?: number;
};
type Ticket = { profile: Profile; expiresAt: number };
export class RoomObject {
  private engine: RoomEngine | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private dirtyDirectory = false;
  private closed = false;
  private socialLimits = new Map<number, { chatWindow: number; chatCount: number; reactionWindow: number; reactionCount: number }>();
  private lastLoggedState: WatchRoomState | null = null;
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.blockConcurrencyWhile(async () => {
      const data = await ctx.storage.get<EngineData>('engine');
      if (data) {
        if (!Array.isArray(data.state.chat)) {
          data.state.chat = [];
        }
        this.engine = new RoomEngine(data);
      }
      const savedLimits = await ctx.storage.get<Record<string, { chatWindow: number; chatCount: number; reactionWindow: number; reactionCount: number }>>('socialLimits');
      if (savedLimits) {
        for (const [k, v] of Object.entries(savedLimits)) {
          this.socialLimits.set(Number(k), v);
        }
      }
      if (this.engine) this.lastLoggedState = this.engine.snapshot();
      this.dirtyDirectory = await ctx.storage.get<boolean>('directoryPending') ?? false;
      this.closed = await ctx.storage.get<boolean>('closed') ?? false;
    });
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation); this.tail = result.catch(() => undefined); return result;
  }
  private send(socket: WebSocket, message: ServerMessage) { try { socket.send(JSON.stringify(message)); } catch { /* close event updates presence */ } }
  private broadcast() {
    if (!this.engine) return;
    const state = this.engine.snapshot();
    for (const socket of this.ctx.getWebSockets()) this.send(socket, { type: 'room_state', state, serverTime: Date.now() });
  }
  private closeProfile(profileId: number, type: 'kicked' | 'session_replaced', except?: WebSocket) {
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.profileId === profileId && socket !== except) {
        this.send(socket, { type });
        // Tombstone survives hibernation; closing an old socket cannot disconnect its replacement.
        socket.serializeAttachment({ ...attachment, connectionId: 'removed' });
        socket.close(1000, type);
        businessLog('disconnected', { roomId: this.engine!.state.roomId, reason: type });
      }
    }
  }
  private async persist(callerSocket?: WebSocket, callerCommandId?: string, alreadyStored = false) {
    const engine = this.engine!;
    const limitsObj: Record<string, { chatWindow: number; chatCount: number; reactionWindow: number; reactionCount: number }> = {};
    const now = Date.now();
    for (const [k, v] of this.socialLimits.entries()) {
      if (now - v.chatWindow <= 10_000 || now - v.reactionWindow <= 5_000) {
        limitsObj[k] = v;
      } else {
        this.socialLimits.delete(k);
      }
    }
    const previous = this.lastLoggedState;
    if (!alreadyStored) {
      const retainedIds = new Set((engine.state.chat ?? []).map(message => message.id));
      const evictedFile = previous?.chat?.some(message => message.attachment && !retainedIds.has(message.id));
      const values = {engine: engine.exportData(), directoryPending: true, socialLimits: limitsObj};
      if (evictedFile) {
        await this.ctx.storage.transaction(async storage => {
          await storage.put(values);
          await cleanEvictedAttachments(storage, engine.state.chat ?? []);
        });
      } else await this.ctx.storage.put(values);
    }
    this.dirtyDirectory = true;
    const state = engine.snapshot();
    if (previous?.barrier && !state.barrier && Date.now() >= previous.barrier.deadline) businessLog('wait_timeout', { roomId: state.roomId });
    if (previous && previous.hostId !== state.hostId) businessLog('host_changed', { roomId: state.roomId });
    if (state.closed && !previous?.closed) businessLog('room_closed', { roomId: state.roomId });
    this.lastLoggedState = state;
    try {
      const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory-v2'));
      const response = await stub.fetch(new Request('https://internal/update', { method: 'POST', body: JSON.stringify({ state }) }));
      if (!response.ok) throw new Error('directory update failed');
      await this.ctx.storage.put('directoryPending', false);
      this.dirtyDirectory = false;
    } catch { /* retry by durable alarm; room remains authoritative */ }
    let deadline = engine.nextDeadline();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (attachment.connectionId !== 'removed') deadline = Math.min(deadline ?? Infinity, attachment.lastSeen + 15_000);
    }
    const tickets = await this.ctx.storage.list<Ticket>({ prefix: 'ticket:', limit: 100 });
    for (const value of tickets.values()) deadline = Math.min(deadline ?? Infinity, value.expiresAt);
    if (this.dirtyDirectory) deadline = Math.min(deadline ?? Infinity, Date.now() + 30_000);
    if (!state.closed) {
      if (deadline !== null && Number.isFinite(deadline)) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1, deadline));
      else await this.ctx.storage.deleteAlarm();
    }
    if (state.closed) {
      if (callerSocket && callerCommandId) {
        this.send(callerSocket, { type: 'ack', commandId: callerCommandId, revision: state.revision });
      }
      for (const socket of this.ctx.getWebSockets()) { this.send(socket, { type: 'room_closed' }); const meta = socket.deserializeAttachment() as Attachment; socket.serializeAttachment({...meta, connectionId: 'removed'}); socket.close(1000, 'room_closed'); }
      this.closed = true;
      engine.state.chat = [];
      await this.ctx.storage.put({closed: true, engine: engine.exportData()});
      await this.ctx.storage.setAlarm(Date.now() + 15_000);
      try {
        await eraseAllAttachmentData(this.ctx.storage);
        if (!this.dirtyDirectory) {
          await this.ctx.storage.deleteAll();
          await this.ctx.storage.put('closed', true);
          await this.ctx.storage.deleteAlarm();
        }
      } catch (err) {
        await this.ctx.storage.setAlarm(Date.now() + 15_000);
        throw err;
      }
    }
  }
  async fetch(request: Request): Promise<Response> {
    return this.serial(async () => {
      const url = new URL(request.url), now = Date.now();
      if (this.closed) return json({ code: 'ROOM_CLOSED' }, 410);
      if (url.pathname === '/init' && request.method === 'POST') {
        if (this.engine) return json({ code: 'ROOM_EXISTS' }, 409);
        this.engine = RoomEngine.create(await request.json(), now);
        await this.persist(); return json({ ok: true });
      }
      if (!this.engine) return json({ code: 'ROOM_NOT_FOUND' }, 404);
      const revision = this.engine.state.revision;
      this.engine.tick(now);
      if (this.engine.state.revision !== revision) { await this.persist(); this.broadcast(); }
      if (this.engine.snapshot().closed) { await this.persist(); return json({ code: 'ROOM_CLOSED' }, 410); }
      if (url.pathname === '/ticket' && request.method === 'POST') {
        const { profile, code } = await request.json() as { profile: Profile; code?: string };
        const state = this.engine.snapshot();
        if (state.visibility !== 'public' && code !== state.joinCode && !state.participants.some(p => p.profileId === profile.profileId)) return json({ code: 'INVITE_REQUIRED' }, 403);
        const ticket = crypto.randomUUID();
        await this.ctx.storage.put(`ticket:${ticket}`, { profile, expiresAt: now + 30_000 } satisfies Ticket);
        await this.persist();
        return json({ roomId: state.roomId, ticket, state });
      }
      if (url.pathname === '/ws' && request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
        const ticketId = url.searchParams.get('ticket') ?? '';
        if (!/^[a-f0-9-]{36}$/.test(ticketId)) return json({ code: 'INVALID_TICKET' }, 401);
        const ticket = await this.ctx.storage.get<Ticket>(`ticket:${ticketId}`);
        await this.ctx.storage.delete(`ticket:${ticketId}`);
        if (!ticket || ticket.expiresAt <= now) return json({ code: 'INVALID_TICKET' }, 401);
        this.engine.connect(ticket.profile, now);
        const pair = new WebSocketPair(), client = pair[0], server = pair[1];
        server.serializeAttachment({
          profileId: ticket.profile.profileId,
          connectionId: crypto.randomUUID(),
          window: now,
          messages: 0,
          lastSeen: now,
          chatWindow: now,
          chatCount: 0,
          reactionWindow: now,
          reactionCount: 0,
        } satisfies Attachment);
        this.ctx.acceptWebSocket(server);
        this.closeProfile(ticket.profile.profileId, 'session_replaced', server);
        await this.persist(); this.broadcast();
        businessLog('connected', { roomId: this.engine.state.roomId });
        return new Response(null, { status: 101, webSocket: client });
      }
      if (url.pathname === '/attachment-precheck' && request.method === 'POST') {
        if (this.closed || (this.engine && this.engine.snapshot().closed)) return json({ code: 'ROOM_CLOSED' }, 410);
        if (!this.engine) return json({ code: 'ROOM_NOT_FOUND' }, 404);
        const { profileId } = await request.json() as { profileId: number };
        const state = this.engine.snapshot();
        const isMember = state.participants.some(p => p.profileId === profileId);
        if (!isMember) return json({ code: 'INVITE_REQUIRED' }, 403);
        return json({ ok: true });
      }
      if (url.pathname === '/attachment-commit' && request.method === 'POST') {
        if (this.closed || !this.engine || this.engine.snapshot().closed) return json({ code: 'ROOM_CLOSED' }, 410);
        const profileStr = request.headers.get('X-Profile');
        if (!profileStr) return json({ code: 'SESSION_REQUIRED' }, 401);
        const profile = JSON.parse(profileStr) as Profile;
        const kind = request.headers.get('X-Attachment-Kind') as RoomAttachmentKind;
        if (kind !== 'image' && kind !== 'voice') return json({ code: 'INVALID_KIND' }, 400);
        const uploadId = request.headers.get('X-Attachment-Upload-Id') ?? '';
        if (!uploadId || uploadId.length > 80) return json({ code: 'INVALID_UPLOAD_ID' }, 400);

        const state = this.engine.snapshot();
        const participant = state.participants.find(p => p.profileId === profile.profileId);
        if (!participant) return json({ code: 'INVITE_REQUIRED' }, 403);

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength === 0) return json({ code: 'EMPTY_ATTACHMENT' }, 400);
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return json({ code: 'BODY_TOO_LARGE' }, 413);

        const rawName = request.headers.get('X-Attachment-Name') ?? '';
        let decodedName = '';
        try { decodedName = decodeURIComponent(rawName); } catch { decodedName = ''; }
        decodedName = decodedName.replace(/[/\\]/g, '').trim().slice(0, 255);
        if (!decodedName) decodedName = kind === 'image' ? 'image.png' : 'voice.webm';

        const rawText = request.headers.get('X-Attachment-Text') ?? '';
        let caption = '';
        try { caption = rawText ? decodeURIComponent(rawText).trim() : ''; } catch { return json({code:'INVALID_CAPTION'},400); }
        if (caption.length > MAX_CHAT_LENGTH) return json({ code: 'CAPTION_TOO_LONG' }, 400);
        const defaultPlaceholder = kind === 'image' ? '📷 Изображение' : '🎤 Голосовое сообщение';
        const messageText = caption || defaultPlaceholder;

        const sniffed = sniffMimeType(bytes);
        if (!sniffed) return json({ code: 'UNSUPPORTED_MEDIA_TYPE' }, 415);
        if (sniffed.kind !== kind) return json({ code: 'KIND_MIMETYPE_MISMATCH' }, 400);

        const declaredMime = (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
        if (declaredMime !== sniffed.mimeType) return json({code:'KIND_MIMETYPE_MISMATCH'},400);

        let cleanDurationMs: number | undefined;
        if (kind === 'voice') {
          const durStr = request.headers.get('X-Attachment-Duration');
          const durNum = Number(durStr);
          if (!Number.isFinite(durNum) || durNum <= 0 || durNum > MAX_VOICE_DURATION_MS) {
            return json({ code: 'INVALID_DURATION' }, 400);
          }
          cleanDurationMs = Math.round(durNum);
        }

        // Include the whole submission so conflicting retry metadata is rejected.
        const hash = await sha256Hex(new TextEncoder().encode(JSON.stringify({bytes: await sha256Hex(bytes), kind, name: decodedName, text: messageText, mime: declaredMime, durationMs: cleanDurationMs ?? null})));
        const existingReceipt = await getUploadReceipt(this.ctx.storage, profile.profileId, uploadId);
        if (existingReceipt) {
          if (
            existingReceipt.hash === hash &&
            existingReceipt.kind === kind &&
            existingReceipt.name === decodedName &&
            (existingReceipt.text === undefined || existingReceipt.text === messageText)
          ) {
            const existingMsg = state.chat?.find(m => m.id === existingReceipt.messageId);
            if (existingMsg) return json({ message: existingMsg }, 200);
            const existingAtt = await loadAttachment(this.ctx.storage, existingReceipt.attachmentId);
            if (existingAtt) {
              const restoredMsg: RoomChatMessage = {
                id: existingReceipt.messageId,
                profileId: profile.profileId,
                login: participant.login,
                avatar: participant.avatar,
                text: existingReceipt.text ?? messageText,
                createdAt: existingAtt.meta.createdAt,
                attachment: {
                  id: existingAtt.meta.id,
                  kind: existingAtt.meta.kind,
                  mimeType: existingAtt.meta.mimeType,
                  size: existingAtt.meta.size,
                  name: existingAtt.meta.name,
                  durationMs: existingAtt.meta.durationMs,
                },
              };
              return json({ message: restoredMsg }, 200);
            }
          }
          return json({ code: 'IDEMPOTENCY_CONFLICT' }, 409);
        }

        // Upload rate limiting per author: max 10 per 60s
        const limitKey = `att:limit:${profile.profileId}`;
        const currentLimit = await this.ctx.storage.get<{ count: number; window: number }>(limitKey);
        const limit = currentLimit && now - currentLimit.window < 60_000 ? currentLimit : { count: 0, window: now };
        if (++limit.count > 10) return json({ code: 'RATE_LIMITED' }, 429);
        await this.ctx.storage.put(limitKey, limit);

        const attachmentId = crypto.randomUUID();
        const messageId = crypto.randomUUID();

        const meta: StoredAttachmentMeta = {
          id: attachmentId,
          roomId: state.roomId,
          kind,
          mimeType: sniffed.mimeType,
          size: bytes.byteLength,
          name: decodedName,
          durationMs: cleanDurationMs,
          profileId: profile.profileId,
          createdAt: now,
          chunkCount: 0,
          messageId,
        };

        const attachment: RoomAttachment = {
          id: attachmentId,
          kind,
          mimeType: sniffed.mimeType,
          size: bytes.byteLength,
          name: decodedName,
          ...(cleanDurationMs !== undefined ? { durationMs: cleanDurationMs } : {}),
        };

        const message: RoomChatMessage = {
          id: messageId,
          profileId: participant.profileId,
          login: participant.login,
          avatar: participant.avatar,
          text: messageText,
          createdAt: now,
          attachment,
        };

        // Keep binary chunks, history, receipts and evictions in one SQLite transaction.
        // The live engine is swapped only after commit, so failed writes cannot
        // evict an older file or leak an unpublished attachment.
        const nextEngine = new RoomEngine(this.engine.exportData());
        nextEngine.addChatMessage(message);
        const limitsObj = Object.fromEntries(this.socialLimits);
        await this.ctx.storage.transaction(async storage => {
          await saveAttachment(storage, meta, bytes, uploadId, hash, messageText);
          await cleanEvictedAttachments(storage, nextEngine.state.chat ?? []);
          await storage.put({engine: nextEngine.exportData(), directoryPending: true, socialLimits: limitsObj});
        });
        this.engine = nextEngine;
        await this.persist(undefined, undefined, true);

        this.broadcast();
        return json({ message }, 200);
      }
      if (url.pathname.startsWith('/attachments/') && request.method === 'GET') {
        if (this.closed || (this.engine && this.engine.snapshot().closed)) return json({ code: 'ROOM_CLOSED' }, 410);
        if (!this.engine) return json({ code: 'ROOM_NOT_FOUND' }, 404);
        const attachmentId = url.pathname.slice('/attachments/'.length);
        const profileId = Number(url.searchParams.get('profileId'));
        const state = this.engine.snapshot();
        const isMember = state.participants.some(p => p.profileId === profileId);
        if (!isMember) return json({ code: 'INVITE_REQUIRED' }, 403);

        const record = await loadAttachment(this.ctx.storage, attachmentId);
        if (!record || record.meta.roomId !== state.roomId) return json({ code: 'NOT_FOUND' }, 404);

        return new Response(record.bytes, {
          status: 200,
          headers: {
            'Content-Type': record.meta.mimeType,
            'X-Content-Type-Options': 'nosniff',
            'Cache-Control': 'no-store',
          },
        });
      }
      return json({ code: 'NOT_FOUND' }, 404);
    });
  }
  async webSocketMessage(socket: WebSocket, raw: string | ArrayBuffer) {
    await this.serial(async () => {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (this.closed || attachment.connectionId === 'removed' || !this.engine) return;
      const now = Date.now();
      const revision = this.engine.state.revision;
      this.engine.tick(now);
      if (this.engine.state.revision !== revision) { await this.persist(); this.broadcast(); }
      if (this.engine.state.closed) return;
      if (now - attachment.window > 10_000) { attachment.window = now; attachment.messages = 0; }
      attachment.messages++; attachment.lastSeen = now; socket.serializeAttachment(attachment);
      if (attachment.messages > 100) {
        if (attachment.messages === 101) businessLog('command_rejected', { roomId: this.engine.state.roomId, code: 'RATE_LIMITED' });
        this.send(socket, { type: 'error', code: 'RATE_LIMITED', message: 'Too many messages' }); return;
      }
      let commandId: string | undefined;
      try {
        if (typeof raw !== 'string' || raw.length > 8192) throw new Error('INVALID_MESSAGE');
        const message = parseClientMessage(JSON.parse(raw));
        if (message.type === 'ping') { this.send(socket, { type: 'pong', requestId: message.requestId, serverTime: now }); return; }
        if (message.type === 'sync_request') { this.engine.tick(now); await this.persist(); this.send(socket, { type: 'room_state', state: this.engine.snapshot(), serverTime: now }); return; }
        commandId = message.commandId;
        if (this.engine.isDuplicate(attachment.profileId, commandId)) {
          this.send(socket, { type: 'ack', commandId, revision: this.engine.snapshot().revision });
          return;
        }
        let limit = this.socialLimits.get(attachment.profileId);
        if (!limit) {
          limit = { chatWindow: now, chatCount: 0, reactionWindow: now, reactionCount: 0 };
          this.socialLimits.set(attachment.profileId, limit);
        }
        if (message.type === 'chat_message') {
          if (now - limit.chatWindow > 10_000) {
            limit.chatWindow = now;
            limit.chatCount = 0;
          }
          limit.chatCount++;
          if (limit.chatCount > 10) {
            businessLog('command_rejected', { roomId: this.engine.state.roomId, code: 'RATE_LIMITED' });
            this.send(socket, { type: 'error', code: 'RATE_LIMITED', message: 'Rate limit exceeded', commandId });
            return;
          }
        } else if (message.type === 'reaction') {
          if (now - limit.reactionWindow > 5_000) {
            limit.reactionWindow = now;
            limit.reactionCount = 0;
          }
          limit.reactionCount++;
          if (limit.reactionCount > 15) {
            businessLog('command_rejected', { roomId: this.engine.state.roomId, code: 'RATE_LIMITED' });
            this.send(socket, { type: 'error', code: 'RATE_LIMITED', message: 'Rate limit exceeded', commandId });
            return;
          }
        }
        const result = this.engine.command(attachment.profileId, message, now);
        if (result.closed) {
          await this.persist(socket, commandId);
          return;
        }
        await this.persist();
        if (result.duplicate) {
          this.send(socket, { type: 'ack', commandId, revision: this.engine.snapshot().revision });
          return;
        }
        if (result.reaction) {
          this.send(socket, { type: 'ack', commandId, revision: this.engine.snapshot().revision });
          for (const s of this.ctx.getWebSockets()) this.send(s, { type: 'reaction', reaction: result.reaction });
          return;
        }
        this.send(socket, { type: 'ack', commandId, revision: this.engine.snapshot().revision });
        if (result.kicked !== undefined) this.closeProfile(result.kicked, 'kicked');
        if (result.left !== undefined) {
          for (const candidate of this.ctx.getWebSockets()) {
            const meta = candidate.deserializeAttachment() as Attachment;
            if (meta.profileId === result.left) {
              candidate.serializeAttachment({ ...meta, connectionId: 'removed' }); candidate.close(1000, 'left');
              businessLog('disconnected', { roomId: this.engine.state.roomId, reason: 'left' });
            }
          }
        }
        this.broadcast();
      } catch (error) {
        const code = error instanceof DomainError ? error.code : error instanceof SyntaxError || (error instanceof Error && /^INVALID_(MESSAGE|COMMAND)$/.test(error.message)) ? 'INVALID_MESSAGE' : 'INTERNAL_ERROR';
        businessLog('command_rejected', { roomId: this.engine.state.roomId, code });
        this.send(socket, { type: 'error', code, message: code, commandId });
      }
    });
  }
  async webSocketClose(socket: WebSocket) {
    await this.serial(async () => {
      const attachment = socket.deserializeAttachment() as Attachment;
      if (this.closed || attachment.connectionId === 'removed' || !this.engine) return;
      socket.serializeAttachment({ ...attachment, connectionId: 'removed' });
      this.engine.disconnect(attachment.profileId, Date.now());
      await this.persist(); this.broadcast();
      businessLog('disconnected', { roomId: this.engine.state.roomId, reason: 'closed' });
    });
  }
  async webSocketError(socket: WebSocket) { await this.webSocketClose(socket); }
  async alarm() {
    await this.serial(async () => {
      const now = Date.now();
      for (const socket of this.ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as Attachment;
        if (attachment.connectionId !== 'removed' && attachment.lastSeen + 15_000 <= now) {
          socket.serializeAttachment({ ...attachment, connectionId: 'removed' });
          socket.close(4000, 'heartbeat_timeout');
          this.engine?.disconnect(attachment.profileId, now);
          if (this.engine) businessLog('disconnected', { roomId: this.engine.state.roomId, reason: 'heartbeat_timeout' });
        }
      }
      for (const [name, value] of await this.ctx.storage.list<Ticket>({ prefix: 'ticket:', limit: 100 })) if (value.expiresAt <= now) await this.ctx.storage.delete(name);
      if (this.closed || (this.engine && this.engine.state.closed)) {
        try {
          await eraseAllAttachmentData(this.ctx.storage);
        } catch {
          await this.ctx.storage.setAlarm(now + 15_000);
          return;
        }
        if (this.dirtyDirectory) {
          try {
            const state = this.engine ? this.engine.snapshot() : (await this.ctx.storage.get<EngineData>('engine'))?.state;
            if (state) {
              const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory-v2'));
              const response = await stub.fetch(new Request('https://internal/update', { method: 'POST', body: JSON.stringify({ state }) }));
              if (response.ok) {
                this.dirtyDirectory = false;
                await this.ctx.storage.deleteAll();
                await this.ctx.storage.put('closed', true);
                await this.ctx.storage.deleteAlarm();
              } else {
                await this.ctx.storage.setAlarm(now + 15_000);
              }
            }
          } catch {
            await this.ctx.storage.setAlarm(now + 15_000);
          }
        } else {
          await this.ctx.storage.deleteAll();
          await this.ctx.storage.put('closed', true);
          await this.ctx.storage.deleteAlarm();
        }
        return;
      }
      if (this.engine) { this.engine.tick(now); await this.persist(); this.broadcast(); }
    });
  }
}

type DirectoryEntry = { roomId: string; code: string; room: PublicRoom | null; expiresAt: number };
type MigrationMeta = {
  stage: 'rooms' | 'limits' | 'done';
  cursor?: string;
};

function pad13(timestamp: number): string {
  return String(timestamp).padStart(13, '0');
}

export class RoomDirectory {
  private migrated = false;
  private migrationRunning = false;
  private stepLock: Promise<boolean> | null = null;
  private readonly ctx: DurableObjectState;
  readonly ready: Promise<void>;

  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
    this.ready = (async () => {
      const meta = await ctx.storage.get<MigrationMeta>('meta:migration');
      if (meta?.stage === 'done') {
        this.migrated = true;
        return;
      }
      if (!meta) {
        const anyKey = await ctx.storage.list({ limit: 1 });
        if (anyKey.size === 0) {
          await ctx.storage.put('meta:migration', { stage: 'done' } satisfies MigrationMeta);
          this.migrated = true;
          return;
        }
        await ctx.storage.put('meta:migration', { stage: 'rooms' } satisfies MigrationMeta);
        this.migrated = false;
      } else {
        this.migrated = false;
      }
    })();
    ctx.blockConcurrencyWhile(() => this.ready);
  }

  get isMigrated(): boolean {
    return this.migrated;
  }

  private triggerMigration(): void {
    if (this.migrated || this.migrationRunning) return;
    this.migrationRunning = true;
    const task = (async () => {
      try {
        while (!this.migrated) {
          const done = await this.stepMigration();
          if (done) break;
        }
      } catch {
        // Will be resumed by next request or alarm
      } finally {
        this.migrationRunning = false;
      }
    })();
    if (this.ctx.waitUntil) {
      this.ctx.waitUntil(task);
    }
  }

  async stepMigration(): Promise<boolean> {
    await this.ready;
    if (this.migrated) return true;
    if (this.stepLock) return await this.stepLock;
    const execute = this.executeStepMigration();
    this.stepLock = execute;
    try {
      return await execute;
    } finally {
      this.stepLock = null;
    }
  }

  private async executeStepMigration(): Promise<boolean> {
    if (this.migrated) return true;
    return await this.ctx.storage.transaction(async storage => {
      const meta = await storage.get<MigrationMeta>('meta:migration') ?? { stage: 'rooms' };
      if (meta.stage === 'done') {
        this.migrated = true;
        return true;
      }

      const now = Date.now();

      if (meta.stage === 'rooms') {
        const batch = await storage.list<DirectoryEntry>({
          prefix: 'room:',
          limit: 100,
          startAfter: meta.cursor ? meta.cursor : undefined,
        });

        if (batch.size === 0) {
          await storage.put('meta:migration', { stage: 'limits' } satisfies MigrationMeta);
          return false;
        }

        const keys = Array.from(batch.keys());
        const puts: Record<string, unknown> = {};
        for (const roomKey of keys) {
          const current = await storage.get<DirectoryEntry>(roomKey);
          if (!current) continue;
          if (current.room && current.expiresAt > now) {
            puts[`public:${current.roomId}`] = true;
          }
          if (current.expiresAt !== Number.MAX_SAFE_INTEGER) {
            puts[`expiry:${pad13(current.expiresAt)}:room:${roomKey}`] = true;
          }
        }
        if (Object.keys(puts).length > 0) {
          await storage.put(puts);
        }

        const lastKey = keys[keys.length - 1];
        if (batch.size < 100) {
          await storage.put('meta:migration', { stage: 'limits' } satisfies MigrationMeta);
        } else {
          await storage.put('meta:migration', { stage: 'rooms', cursor: lastKey } satisfies MigrationMeta);
        }
        return false;
      }

      if (meta.stage === 'limits') {
        const batch = await storage.list<{ count: number; until: number }>({
          prefix: 'limit:',
          limit: 100,
          startAfter: meta.cursor ? meta.cursor : undefined,
        });

        if (batch.size === 0) {
          await storage.put('meta:migration', { stage: 'done' } satisfies MigrationMeta);
          this.migrated = true;
          await this.scheduleEarliestAlarm(storage);
          return true;
        }

        const keys = Array.from(batch.keys());
        const puts: Record<string, unknown> = {};
        for (const limitKey of keys) {
          const current = await storage.get<{ count: number; until: number }>(limitKey);
          if (!current) continue;
          puts[`expiry:${pad13(current.until)}:limit:${limitKey}`] = true;
        }
        if (Object.keys(puts).length > 0) {
          await storage.put(puts);
        }

        const lastKey = keys[keys.length - 1];
        if (batch.size < 100) {
          await storage.put('meta:migration', { stage: 'done' } satisfies MigrationMeta);
          this.migrated = true;
          await this.scheduleEarliestAlarm(storage);
          return true;
        } else {
          await storage.put('meta:migration', { stage: 'limits', cursor: lastKey } satisfies MigrationMeta);
          return false;
        }
      }

      return false;
    });
  }

  private async scheduleEarliestAlarm(storage: DurableObjectStorage | DurableObjectTransaction): Promise<void> {
    const list = await storage.list<unknown>({ prefix: 'expiry:', limit: 1 });
    if (list.size === 0) return;
    const key = Array.from(list.keys())[0];
    const match = /^expiry:(\d{13}):/.exec(key);
    if (!match) return;
    const expiryTimestamp = Number(match[1]);
    const currentAlarm = await storage.getAlarm();
    const targetAlarm = Math.max(Date.now() + 1, expiryTimestamp);
    if (currentAlarm === null || targetAlarm < currentAlarm) {
      await storage.setAlarm(targetAlarm);
    }
  }

  async fetch(request: Request) {
    await this.ready;
    const url = new URL(request.url), now = Date.now();
    if (url.pathname === '/limit') {
      const { key, max } = await request.json() as { key: string; max: number };
      return this.ctx.storage.transaction(async storage => {
        const name = `limit:${key}`;
        const value = await storage.get<{ count: number; until: number }>(name);
        const limit = value && value.until > now ? value : { count: 0, until: now + 60_000 };
        if (++limit.count > max) return json({ code: 'RATE_LIMITED' }, 429);
        const expiryKey = `expiry:${pad13(limit.until)}:limit:${name}`;
        if (value && value.until <= now && value.until !== limit.until) {
          await storage.delete(`expiry:${pad13(value.until)}:limit:${name}`);
        }
        await storage.put({ [name]: limit, [expiryKey]: true });
        const currentAlarm = await storage.getAlarm();
        if (currentAlarm === null || limit.until < currentAlarm) {
          await storage.setAlarm(limit.until);
        }
        return json({ ok: true });
      });
    }
    if (url.pathname === '/reserve') {
      const { roomId } = await request.json() as { roomId: string };
      return this.ctx.storage.transaction(async storage => {
        const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
        let code = '';
        do {
          code = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => alphabet[n % alphabet.length]).join('');
        } while (await storage.get(`code:${code}`));
        const expiresAt = now + 60_000;
        const entry: DirectoryEntry = { roomId, code, room: null, expiresAt };
        const expiryKey = `expiry:${pad13(expiresAt)}:room:room:${roomId}`;
        await storage.put({
          [`code:${code}`]: roomId,
          [`room:${roomId}`]: entry,
          [expiryKey]: true,
        });
        const currentAlarm = await storage.getAlarm();
        if (currentAlarm === null || expiresAt < currentAlarm) {
          await storage.setAlarm(expiresAt);
        }
        return json({ code });
      });
    }
    if (url.pathname === '/update') {
      const { state } = await request.json() as { state: import('../protocol/index.ts').WatchRoomState };
      return this.ctx.storage.transaction(async storage => {
        const canonicalKey = `room:${state.roomId}`;
        const oldEntry = await storage.get<DirectoryEntry>(canonicalKey);
        const toDelete: string[] = [];

        if (oldEntry && oldEntry.expiresAt !== Number.MAX_SAFE_INTEGER) {
          toDelete.push(`expiry:${pad13(oldEntry.expiresAt)}:room:${canonicalKey}`);
        }

        if (state.closed) {
          toDelete.push(canonicalKey, `code:${state.joinCode}`, `public:${state.roomId}`);
          if (oldEntry && oldEntry.code !== state.joinCode) {
            toDelete.push(`code:${oldEntry.code}`);
          }
          if (toDelete.length > 0) await storage.delete(toDelete);
          return json({ ok: true });
        }

        const isPublic = state.visibility === 'public';
        const entry: DirectoryEntry = {
          roomId: state.roomId,
          code: state.joinCode,
          expiresAt: Number.MAX_SAFE_INTEGER,
          room: isPublic ? {
            roomId: state.roomId,
            title: state.title,
            hostId: state.hostId,
            media: state.media,
            participants: state.participants.filter(p => p.connected).length,
          } : null,
        };

        const puts: Record<string, unknown> = {
          [canonicalKey]: entry,
          [`code:${state.joinCode}`]: state.roomId,
        };

        if (isPublic) {
          puts[`public:${state.roomId}`] = true;
        } else {
          toDelete.push(`public:${state.roomId}`);
        }

        if (oldEntry && oldEntry.code !== state.joinCode) {
          toDelete.push(`code:${oldEntry.code}`);
        }

        if (toDelete.length > 0) await storage.delete(toDelete);
        await storage.put(puts);
        return json({ ok: true });
      });
    }
    if (url.pathname === '/remove') {
      const { roomId, code } = await request.json() as { roomId: string; code: string };
      return this.ctx.storage.transaction(async storage => {
        const canonicalKey = `room:${roomId}`;
        const oldEntry = await storage.get<DirectoryEntry>(canonicalKey);
        const toDelete = [canonicalKey, `code:${code}`, `public:${roomId}`];
        if (oldEntry && oldEntry.expiresAt !== Number.MAX_SAFE_INTEGER) {
          toDelete.push(`expiry:${pad13(oldEntry.expiresAt)}:room:${canonicalKey}`);
        }
        if (oldEntry && oldEntry.code !== code) {
          toDelete.push(`code:${oldEntry.code}`);
        }
        await storage.delete(toDelete);
        return json({ ok: true });
      });
    }
    if (url.pathname === '/resolve') {
      const code = url.searchParams.get('code') ?? '';
      const roomId = await this.ctx.storage.get<string>(`code:${code}`);
      if (!roomId) return json({ code: 'ROOM_NOT_FOUND' }, 404);
      const entry = await this.ctx.storage.get<DirectoryEntry>(`room:${roomId}`);
      return entry && entry.expiresAt > now ? json({ roomId }) : json({ code: 'ROOM_NOT_FOUND' }, 404);
    }
    if (url.pathname === '/list') {
      if (!this.migrated) {
        this.triggerMigration();
        return json({ code: 'DIRECTORY_MIGRATING' }, 503);
      }
      const cursor = url.searchParams.get('cursor') ?? '';
      if (cursor && !/^[a-f0-9-]{36}$/.test(cursor)) return json({ code: 'INVALID_CURSOR' }, 400);

      const entries = await this.ctx.storage.list<unknown>({
        prefix: 'public:',
        limit: 21,
        startAfter: cursor ? `public:${cursor}` : undefined,
      });

      const publicKeys = Array.from(entries.keys());
      const hasMore = publicKeys.length > 20;
      const pageKeys = publicKeys.slice(0, 20);
      const canonicalKeys = pageKeys.map(k => `room:${k.slice('public:'.length)}`);

      const canonicalMap = canonicalKeys.length > 0
        ? await this.ctx.storage.get<DirectoryEntry>(canonicalKeys)
        : new Map<string, DirectoryEntry>();

      const rooms: PublicRoom[] = [];
      for (const cKey of canonicalKeys) {
        const entry = canonicalMap.get(cKey);
        if (entry && entry.room && entry.expiresAt > now) {
          rooms.push(entry.room);
        }
      }

      const nextCursor = hasMore ? publicKeys[19].slice('public:'.length) : null;
      return json({ rooms, cursor: nextCursor });
    }
    if (url.pathname === '/user/settings' && request.method === 'GET') {
      const profileId = url.searchParams.get('profileId');
      if (!profileId) return json({ code: 'INVALID_PROFILE' }, 400);
      const settings = await this.ctx.storage.get(`settings:${profileId}`);
      if (!settings) return json({ code: 'SETTINGS_NOT_FOUND' }, 404);
      return json({ ok: true, settings });
    }
    if (url.pathname === '/user/settings' && request.method === 'POST') {
      const payload = await request.json() as { profileId?: number; data?: unknown };
      if (!payload.profileId || !payload.data) return json({ code: 'INVALID_PAYLOAD' }, 400);
      await this.ctx.storage.put(`settings:${payload.profileId}`, payload.data);
      return json({ ok: true });
    }
    return json({ code: 'NOT_FOUND' }, 404);
  }

  async alarm() {
    await this.ready;
    if (!this.migrated) {
      await this.stepMigration();
      if (!this.migrated) {
        await this.ctx.storage.setAlarm(Date.now() + 1);
        return;
      }
    }

    const now = Date.now();
    await this.ctx.storage.transaction(async storage => {
      const batch = await storage.list<unknown>({ prefix: 'expiry:', limit: 100 });
      if (batch.size === 0) {
        await storage.deleteAlarm();
        return;
      }

      let expiredCount = 0;
      let earliestUpcoming: number | null = null;

      for (const key of batch.keys()) {
        const match = /^expiry:(\d{13}):([^:]+):(.+)$/.exec(key);
        if (!match) {
          await storage.delete(key);
          continue;
        }

        const expiryTimestamp = Number(match[1]);
        const canonicalKey = match[3];

        if (expiryTimestamp > now) {
          earliestUpcoming = expiryTimestamp;
          break;
        }

        expiredCount++;

        if (canonicalKey.startsWith('room:')) {
          const entry = await storage.get<DirectoryEntry>(canonicalKey);
          if (entry) {
            if (entry.expiresAt <= now) {
              await storage.delete([canonicalKey, `code:${entry.code}`, `public:${entry.roomId}`, key]);
            } else {
              // Room was activated or renewed; do not delete canonical record
              await storage.delete(key);
            }
          } else {
            await storage.delete(key);
          }
        } else if (canonicalKey.startsWith('limit:')) {
          const entry = await storage.get<{ count: number; until: number }>(canonicalKey);
          if (entry) {
            if (entry.until <= now) {
              await storage.delete([canonicalKey, key]);
            } else {
              // Limit was renewed; do not delete canonical record
              await storage.delete(key);
            }
          } else {
            await storage.delete(key);
          }
        } else {
          await storage.delete(key);
        }
      }

      if (expiredCount === 100) {
        // More expired keys may remain; continue with immediate alarm without unbounded scan
        await storage.setAlarm(Date.now() + 1);
      } else if (earliestUpcoming !== null) {
        await storage.setAlarm(Math.max(Date.now() + 1, earliestUpcoming));
      } else {
        const next = await storage.list<unknown>({ prefix: 'expiry:', limit: 1 });
        if (next.size > 0) {
          const nextKey = Array.from(next.keys())[0];
          const nextMatch = /^expiry:(\d{13}):/.exec(nextKey);
          if (nextMatch) {
            await storage.setAlarm(Math.max(Date.now() + 1, Number(nextMatch[1])));
            return;
          }
        }
        await storage.deleteAlarm();
      }
    });
  }
}


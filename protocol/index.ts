// Canonical v2 wire contract. npm run sync:protocol vendors this file into the client.
export const PROTOCOL_VERSION = 2;
export const WAIT_MS = 7_000;
export const EMPTY_TTL_MS = 600_000;
export const MAX_CHAT_LENGTH = 500;
export const MAX_CHAT_HISTORY = 50;
export const REACTION_TTL_MS = 4_000;
export const REACTION_EMOJIS = ['heart', 'laugh', 'clap', 'fire', 'surprise', 'sad'] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];
export function isReactionEmoji(value: unknown): value is ReactionEmoji {
    return typeof value === 'string' && (REACTION_EMOJIS as readonly string[]).includes(value);
}

export type RoomVisibility = 'private' | 'public';
export function isRoomVisibility(value: unknown): value is RoomVisibility { return value === 'public' || value === 'private'; }
export type Profile = { profileId: number; login: string; avatar: string | null };
export type RoomMedia = { releaseId: number; releaseName: string; dubId: number; sourceId: number; episode: number; episodeName: string };
export type RoomParticipant = Profile & {
    canControl: boolean; connected: boolean; viewing: boolean;
    status: 'idle' | 'loading' | 'ready' | 'error';
    readyEpoch: number | null; excludedEpoch: number | null;
    disconnectedAt: number | null; error: string | null;
};
export const MAX_ATTACHMENT_BYTES = 5_000_000;
export const MAX_VOICE_DURATION_MS = 120_000;

export type RoomAttachmentKind = 'image' | 'voice';
export function isAttachmentKind(value: unknown): value is RoomAttachmentKind {
    return value === 'image' || value === 'voice';
}

export type RoomAttachment = {
    id: string;
    kind: RoomAttachmentKind;
    mimeType: string;
    size: number;
    name: string;
    durationMs?: number;
};

export type RoomChatMessage = {
    id: string; profileId: number; login: string; avatar: string | null;
    text: string; createdAt: number;
    attachment?: RoomAttachment;
};
export type RoomReaction = {
    id: string; profileId: number; login: string; avatar: string | null;
    emoji: ReactionEmoji; createdAt: number;
};
export type WatchRoomState = {
    protocolVersion: 2; revision: number; roomId: string; joinCode: string;
    title: string; visibility: RoomVisibility; hostId: number; media: RoomMedia | null;
    mediaVersion: number; syncEpoch: number;
    playback: { position: number; paused: boolean; intent: 'playing' | 'paused'; rate: number; updatedAt: number };
    barrier: { id: number; target: number; deadline: number } | null;
    participants: RoomParticipant[]; emptySince: number | null; closed: boolean;
    chat?: RoomChatMessage[];
};
export type RoomCommandPayload =
    | { type: 'set_media'; media: RoomMedia }
    | { type: 'play' | 'pause' | 'seek'; position: number }
    | { type: 'set_rate'; position: number; rate: number }
    | { type: 'set_viewing'; viewing: boolean }
    | { type: 'ready' | 'buffering'; epoch: number }
    | { type: 'load_error'; epoch: number; message: string }
    | { type: 'grant_control' | 'revoke_control' | 'kick' | 'transfer_host'; profileId: number }
    | { type: 'leave' }
    | { type: 'close_room' }
    | { type: 'chat_message'; text: string }
    | { type: 'reaction'; emoji: ReactionEmoji };
export type RoomCommand = RoomCommandPayload & { commandId: string; mediaVersion: number };
export type ClientMessage = RoomCommand | { type: 'sync_request' } | { type: 'ping'; requestId: string };
export type ServerMessage =
    | { type: 'room_state'; state: WatchRoomState; serverTime: number }
    | { type: 'ack'; commandId: string; revision: number }
    | { type: 'error'; code: string; message: string; commandId?: string }
    | { type: 'pong'; requestId: string; serverTime: number }
    | { type: 'kicked' | 'session_replaced' | 'room_closed' }
    | { type: 'reaction'; reaction: RoomReaction };
export type PublicRoom = Pick<WatchRoomState, 'roomId' | 'title' | 'hostId' | 'media'> & { participants: number };

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown, max: number): value is string { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function natural(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function positive(value: unknown): value is number { return natural(value) && value > 0; }
function position(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 604_800; }
export function isAttachment(value: unknown): value is RoomAttachment {
    if (!object(value)) return false;
    if (!text(value.id, 80)) return false;
    if (value.kind !== 'image' && value.kind !== 'voice') return false;
    if (!text(value.mimeType, 100)) return false;
    if (!positive(value.size) || value.size > MAX_ATTACHMENT_BYTES) return false;
    if (!text(value.name, 255)) return false;
    if (value.durationMs !== undefined && (!natural(value.durationMs) || value.durationMs > MAX_VOICE_DURATION_MS)) return false;
    return true;
}
export function isRoomMedia(value: unknown): value is RoomMedia {
    return object(value) && positive(value.releaseId) && positive(value.dubId) && positive(value.sourceId)
        && natural(value.episode) && text(value.releaseName, 300) && text(value.episodeName, 300);
}
export function isChatMessage(value: unknown): value is RoomChatMessage {
    return object(value) && text(value.id, 80) && positive(value.profileId) && text(value.login, 100)
        && (value.avatar === null || text(value.avatar, 2048)) && text(value.text, MAX_CHAT_LENGTH) && natural(value.createdAt)
        && (value.attachment === undefined || isAttachment(value.attachment));
}
export function isRoomReaction(value: unknown): value is RoomReaction {
    return object(value) && text(value.id, 80) && positive(value.profileId) && text(value.login, 100)
        && (value.avatar === null || text(value.avatar, 2048)) && isReactionEmoji(value.emoji) && natural(value.createdAt);
}
export function parseClientMessage(value: unknown): ClientMessage {
    if (!object(value)) throw new Error('INVALID_MESSAGE');
    if (value.type === 'sync_request') return { type: 'sync_request' };
    if (value.type === 'ping' && text(value.requestId, 80)) return { type: 'ping', requestId: value.requestId };
    if (!text(value.commandId, 80)) throw new Error('INVALID_COMMAND');
    const mediaVersion = natural(value.mediaVersion) ? value.mediaVersion : (value.type === 'close_room' ? 0 : -1);
    if (mediaVersion < 0) throw new Error('INVALID_COMMAND');
    const envelope = { commandId: value.commandId, mediaVersion };
    switch (value.type) {
        case 'close_room': return { ...envelope, type: 'close_room' };
        case 'set_media': if (isRoomMedia(value.media)) return { ...envelope, type: value.type, media: value.media }; break;
        case 'play': case 'pause': case 'seek': if (position(value.position)) return { ...envelope, type: value.type, position: value.position }; break;
        case 'set_rate': if (position(value.position) && typeof value.rate === 'number' && [0.5, 0.75, 1, 1.25, 1.5, 2].includes(value.rate)) return { ...envelope, type: value.type, position: value.position, rate: value.rate }; break;
        case 'set_viewing': if (typeof value.viewing === 'boolean') return { ...envelope, type: value.type, viewing: value.viewing }; break;
        case 'ready': case 'buffering': if (natural(value.epoch)) return { ...envelope, type: value.type, epoch: value.epoch }; break;
        case 'load_error': if (natural(value.epoch) && text(value.message, 200)) return { ...envelope, type: value.type, epoch: value.epoch, message: value.message }; break;
        case 'grant_control': case 'revoke_control': case 'kick': case 'transfer_host': if (positive(value.profileId)) return { ...envelope, type: value.type, profileId: value.profileId }; break;
        case 'leave': return { ...envelope, type: 'leave' };
        case 'chat_message': {
            if (typeof value.text === 'string') {
                const trimmed = value.text.trim();
                if (trimmed.length > 0 && trimmed.length <= MAX_CHAT_LENGTH) {
                    return { ...envelope, type: 'chat_message', text: trimmed };
                }
            }
            break;
        }
        case 'reaction': {
            if (isReactionEmoji(value.emoji)) {
                return { ...envelope, type: 'reaction', emoji: value.emoji };
            }
            break;
        }
    }
    throw new Error('INVALID_COMMAND');
}
export function isRoomState(value: unknown): value is WatchRoomState {
    if (!object(value) || value.protocolVersion !== 2 || !natural(value.revision) || !text(value.roomId, 100)
        || !text(value.joinCode, 8) || !text(value.title, 80) || !isRoomVisibility(value.visibility)
        || !natural(value.hostId) || !natural(value.mediaVersion) || !natural(value.syncEpoch)
        || !(value.media === null || isRoomMedia(value.media)) || typeof value.closed !== 'boolean'
        || !(value.emptySince === null || natural(value.emptySince)) || !object(value.playback)) return false;
    const p = value.playback;
    if (!position(p.position) || typeof p.paused !== 'boolean' || !(p.intent === 'playing' || p.intent === 'paused')
        || typeof p.rate !== 'number' || ![0.5, 0.75, 1, 1.25, 1.5, 2].includes(p.rate) || !natural(p.updatedAt)) return false;
    if (!(value.barrier === null || (object(value.barrier) && natural(value.barrier.id) && position(value.barrier.target) && natural(value.barrier.deadline)))) return false;
    if (!Array.isArray(value.participants) || !value.participants.every(u => object(u) && positive(u.profileId)
        && text(u.login, 100) && (u.avatar === null || text(u.avatar, 2048)) && typeof u.canControl === 'boolean'
        && typeof u.connected === 'boolean' && typeof u.viewing === 'boolean' && (u.status === 'idle' || u.status === 'loading' || u.status === 'ready' || u.status === 'error')
        && (u.readyEpoch === null || natural(u.readyEpoch)) && (u.excludedEpoch === null || natural(u.excludedEpoch))
        && (u.disconnectedAt === null || natural(u.disconnectedAt)) && (u.error === null || text(u.error, 200)))) return false;
    if (value.chat !== undefined && (!Array.isArray(value.chat) || !value.chat.every(isChatMessage))) return false;
    return true;
}
export function parseServerMessage(value: unknown): ServerMessage {
    if (!object(value)) throw new Error('INVALID_SERVER_MESSAGE');
    if (value.type === 'room_state' && isRoomState(value.state) && natural(value.serverTime)) {
        if (!Array.isArray(value.state.chat)) (value.state as WatchRoomState).chat = [];
        return { type: value.type, state: value.state, serverTime: value.serverTime };
    }
    if (value.type === 'ack' && text(value.commandId, 80) && natural(value.revision)) return { type: value.type, commandId: value.commandId, revision: value.revision };
    if (value.type === 'error' && text(value.code, 80) && text(value.message, 300) && (value.commandId === undefined || text(value.commandId, 80))) return { type: value.type, code: value.code, message: value.message, commandId: value.commandId };
    if (value.type === 'pong' && text(value.requestId, 80) && natural(value.serverTime)) return { type: value.type, requestId: value.requestId, serverTime: value.serverTime };
    if (value.type === 'kicked' || value.type === 'session_replaced' || value.type === 'room_closed') return { type: value.type };
    if (value.type === 'reaction' && isRoomReaction(value.reaction)) return { type: 'reaction', reaction: value.reaction };
    throw new Error('INVALID_SERVER_MESSAGE');
}

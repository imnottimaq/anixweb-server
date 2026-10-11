import {
    EMPTY_TTL_MS,
    WAIT_MS,
    MAX_CHAT_HISTORY,
    type Profile,
    type RoomCommand,
    type RoomParticipant,
    type WatchRoomState,
    type RoomVisibility,
    type RoomChatMessage,
    type RoomReaction,
} from '../protocol/index.ts';

export class DomainError extends Error {
    readonly code: string;
    constructor(code: string) { super(code); this.code = code; }
}
export type EngineData = { state: WatchRoomState; commands: Array<{ key: string; at: number }> };
export type CommandResult = { duplicate: boolean; kicked?: number; left?: number; reaction?: RoomReaction; closed?: boolean };

export function playbackPosition(state: WatchRoomState, now: number): number {
    const p = state.playback;
    return Math.min(604_800, Math.max(0, p.position + (p.paused ? 0 : Math.max(0, now - p.updatedAt) / 1000 * p.rate)));
}

// Pure synchronous room authority. The adapter must persist exportData() before
// acknowledging or broadcasting an accepted change. All deadlines survive sleep.
export class RoomEngine {
    readonly state: WatchRoomState;
    private commands: Array<{ key: string; at: number }>;
    private random: () => number;

    constructor(data: EngineData, random: () => number = () => crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000) {
        this.state = structuredClone(data.state);
        this.state.chat = Array.isArray(data.state.chat) ? structuredClone(data.state.chat) : [];
        this.commands = structuredClone(data.commands);
        this.random = random;
    }
    static create(input: { roomId: string; joinCode: string; title: string; visibility: RoomVisibility; host: Profile }, now: number): RoomEngine {
        return new RoomEngine({
            state: {
                protocolVersion: 2, revision: 0, roomId: input.roomId, joinCode: input.joinCode,
                title: input.title, visibility: input.visibility, hostId: input.host.profileId,
                media: null, mediaVersion: 0, syncEpoch: 0,
                playback: { position: 0, paused: true, intent: 'paused', rate: 1, updatedAt: now },
                barrier: null, participants: [{ ...input.host, canControl: true, connected: false,
                    viewing: false, status: 'idle', readyEpoch: null, excludedEpoch: null, disconnectedAt: now, error: null }],
                emptySince: now, closed: false,
                chat: [],
            }, commands: [],
        });
    }
    snapshot(): WatchRoomState { return structuredClone(this.state); }
    exportData(): EngineData { return { state: this.snapshot(), commands: structuredClone(this.commands) }; }
    addChatMessage(message: RoomChatMessage) {
        this.open();
        if (!this.state.chat) this.state.chat = [];
        this.state.chat.push(structuredClone(message));
        if (this.state.chat.length > MAX_CHAT_HISTORY) {
            this.state.chat = this.state.chat.slice(-MAX_CHAT_HISTORY);
        }
        this.bump();
    }
    removeChatMessage(messageId: string) {
        if (!this.state.chat) return;
        const index = this.state.chat.findIndex(m => m.id === messageId);
        if (index !== -1) {
            this.state.chat.splice(index, 1);
            this.state.revision--;
        }
    }
    private open() { if (this.state.closed) throw new DomainError('ROOM_CLOSED'); }
    private freeze(now: number) {
        this.state.playback.position = playbackPosition(this.state, now);
        this.state.playback.updatedAt = now;
        this.state.playback.paused = true;
    }
    private bump() { this.state.revision++; }
    private blockers(): RoomParticipant[] {
        return this.state.participants.filter(p => p.viewing && p.excludedEpoch !== this.state.syncEpoch
            && (!p.connected || p.status !== 'ready' || p.readyEpoch !== this.state.syncEpoch));
    }
    private settle(now: number) {
        if (this.state.barrier && this.blockers().length === 0) this.state.barrier = null;
        this.state.playback.updatedAt = now;
        this.state.playback.paused = this.state.playback.intent === 'paused' || !!this.state.barrier || !this.state.media
            || !this.state.participants.some(p => p.connected && p.viewing && p.status === 'ready');
    }
    private startBarrier(now: number, resetReady: boolean) {
        if (this.state.barrier) return; // Repeated buffering never extends the deadline.
        this.freeze(now);
        this.state.syncEpoch++;
        for (const p of this.state.participants) {
            // A timed-out loader remains exempt until it genuinely becomes ready.
            p.excludedEpoch = p.excludedEpoch !== null && p.status !== 'ready' ? this.state.syncEpoch : null;
            if (resetReady && p.viewing) {
                p.readyEpoch = null;
                if (p.status === 'ready') p.status = 'loading';
            } else if (p.status === 'ready') p.readyEpoch = this.state.syncEpoch;
        }
        this.state.barrier = { id: this.state.syncEpoch, target: this.state.playback.position, deadline: now + WAIT_MS };
        this.settle(now);
    }
    private chooseHost() {
        const candidates = this.state.participants.filter(p => p.connected);
        const previous = this.state.participants.find(p => p.profileId === this.state.hostId);
        if (previous) previous.canControl = false;
        const selected = candidates[Math.min(candidates.length - 1, Math.floor(this.random() * candidates.length))];
        this.state.hostId = selected?.profileId ?? 0;
        if (selected) selected.canControl = true;
    }
    private updateEmpty(now: number) {
        this.state.emptySince = this.state.participants.some(p => p.connected) ? null : this.state.emptySince ?? now;
    }
    connect(profile: Profile, now: number) {
        this.open();
        this.state.playback.position = playbackPosition(this.state, now);
        this.state.playback.updatedAt = now;
        let participant = this.state.participants.find(p => p.profileId === profile.profileId);
        if (!participant) {
            participant = { ...profile, canControl: false, connected: true, viewing: false,
                status: 'idle', readyEpoch: null, excludedEpoch: null, disconnectedAt: null, error: null };
            this.state.participants.push(participant);
        } else Object.assign(participant, profile, {
            connected: true, disconnectedAt: null, viewing: false, status: 'idle',
            readyEpoch: null, excludedEpoch: null, error: null,
        });
        if (!this.state.hostId) { this.state.hostId = profile.profileId; participant.canControl = true; }
        this.updateEmpty(now);
        this.settle(now);
        this.bump();
    }
    disconnect(profileId: number, now: number) {
        if (this.state.closed) return;
        const participant = this.state.participants.find(p => p.profileId === profileId);
        if (!participant || !participant.connected) return;
        this.freeze(now);
        participant.connected = false;
        participant.disconnectedAt = now;
        if (participant.viewing && this.state.media && participant.excludedEpoch !== this.state.syncEpoch) {
            participant.status = 'loading'; participant.readyEpoch = null;
            this.startBarrier(now, false);
        }
        this.updateEmpty(now);
        this.settle(now);
        this.bump();
    }
    isDuplicate(profileId: number, commandId: string): boolean {
        return this.commands.some(c => c.key === `${profileId}:${commandId}`);
    }
    command(profileId: number, command: RoomCommand, now: number): CommandResult {
        this.open();
        const actor = this.state.participants.find(p => p.profileId === profileId && p.connected);
        if (!actor) throw new DomainError('NOT_JOINED');
        const key = `${profileId}:${command.commandId}`;
        if (this.commands.some(c => c.key === key)) return { duplicate: true };
        const isSocial = command.type === 'chat_message' || command.type === 'reaction';
        const ignoresMediaVersion = isSocial || command.type === 'close_room';
        if (!ignoresMediaVersion && command.mediaVersion !== this.state.mediaVersion) throw new DomainError('STALE_MEDIA');
        const manages = ['grant_control', 'revoke_control', 'kick', 'transfer_host'].includes(command.type);
        const controls = ['set_media', 'play', 'pause', 'seek', 'set_rate'].includes(command.type);
        if (manages && profileId !== this.state.hostId) throw new DomainError('HOST_REQUIRED');
        if (controls && !actor.canControl && profileId !== this.state.hostId) throw new DomainError('CONTROL_REQUIRED');
        if (command.type === 'close_room') {
            if (profileId !== this.state.hostId) throw new DomainError('HOST_REQUIRED');
            this.freeze(now);
            this.state.closed = true;
            this.state.barrier = null;
            this.commands = this.commands.filter(c => now - c.at < EMPTY_TTL_MS).slice(-511);
            this.commands.push({ key, at: now });
            this.bump();
            return { duplicate: false, closed: true };
        }
        if (command.type === 'chat_message') {
            const message: RoomChatMessage = {
                id: crypto.randomUUID(),
                profileId: actor.profileId,
                login: actor.login,
                avatar: actor.avatar,
                text: command.text,
                createdAt: now,
            };
            if (!this.state.chat) this.state.chat = [];
            this.state.chat.push(message);
            if (this.state.chat.length > MAX_CHAT_HISTORY) {
                this.state.chat = this.state.chat.slice(-MAX_CHAT_HISTORY);
            }
            this.commands = this.commands.filter(c => now - c.at < EMPTY_TTL_MS).slice(-511);
            this.commands.push({ key, at: now });
            this.bump();
            return { duplicate: false };
        }
        if (command.type === 'reaction') {
            const reaction: RoomReaction = {
                id: crypto.randomUUID(),
                profileId: actor.profileId,
                login: actor.login,
                avatar: actor.avatar,
                emoji: command.emoji,
                createdAt: now,
            };
            this.commands = this.commands.filter(c => now - c.at < EMPTY_TTL_MS).slice(-511);
            this.commands.push({ key, at: now });
            return { duplicate: false, reaction };
        }
        // Snapshot the running anchor before any mutation. Presence/ready updates
        // must not accidentally restart the clock at an older position.
        const runningPosition = playbackPosition(this.state, now);
        this.state.playback.position = runningPosition;
        this.state.playback.updatedAt = now;
        const result: CommandResult = { duplicate: false };
        switch (command.type) {
            case 'set_media':
                this.state.media = structuredClone(command.media);
                this.state.mediaVersion++;
                this.state.playback.position = 0;
                this.state.playback.intent = 'playing';
                this.state.barrier = null;
                for (const p of this.state.participants) { p.excludedEpoch = null; p.error = null; }
                this.startBarrier(now, true);
                break;
            case 'play':
                if (!this.state.media) throw new DomainError('NO_MEDIA');
                this.state.playback.intent = 'playing';
                if (this.blockers().length && !this.state.barrier) this.startBarrier(now, false);
                break;
            case 'pause':
                this.freeze(now);
                this.state.playback.intent = 'paused';
                break;
            case 'seek':
                if (!this.state.media) throw new DomainError('NO_MEDIA');
                this.freeze(now);
                this.state.playback.position = command.position;
                this.state.barrier = null;
                this.startBarrier(now, true);
                break;
            case 'set_rate': this.state.playback.rate = command.rate; break;
            case 'set_viewing':
                actor.viewing = command.viewing;
                actor.status = command.viewing && this.state.media ? 'loading' : 'idle';
                actor.readyEpoch = null; actor.excludedEpoch = null; actor.error = null;
                if (command.viewing && this.state.media) this.startBarrier(now, false);
                break;
            case 'buffering': case 'load_error': case 'ready':
                if (command.epoch !== this.state.syncEpoch) throw new DomainError('STALE_EPOCH');
                if (!actor.viewing || !this.state.media) throw new DomainError('NOT_VIEWING');
                if (command.type === 'ready') {
                    actor.status = 'ready'; actor.readyEpoch = command.epoch;
                    actor.excludedEpoch = null; actor.error = null;
                } else {
                    actor.status = command.type === 'buffering' ? 'loading' : 'error';
                    actor.readyEpoch = null;
                    actor.error = command.type === 'load_error' ? command.message : null;
                    if (actor.excludedEpoch !== this.state.syncEpoch) this.startBarrier(now, false);
                }
                break;
            case 'grant_control': case 'revoke_control': case 'transfer_host': case 'kick': {
                const target = this.state.participants.find(p => p.profileId === command.profileId);
                if (!target) throw new DomainError('PARTICIPANT_NOT_FOUND');
                if (command.type === 'transfer_host') {
                    if (!target.connected) throw new DomainError('PARTICIPANT_OFFLINE');
                    actor.canControl = false; target.canControl = true; this.state.hostId = target.profileId;
                } else if (command.type === 'kick') {
                    if (target.profileId === profileId) throw new DomainError('CANNOT_KICK_HOST');
                    this.state.participants = this.state.participants.filter(p => p.profileId !== target.profileId);
                    result.kicked = target.profileId;
                } else {
                    if (target.profileId === this.state.hostId) throw new DomainError('CANNOT_REVOKE_HOST');
                    target.canControl = command.type === 'grant_control';
                }
                break;
            }
            case 'leave':
                this.state.participants = this.state.participants.filter(p => p.profileId !== profileId);
                if (profileId === this.state.hostId) this.chooseHost();
                result.left = profileId;
                break;
        }
        this.updateEmpty(now);
        this.settle(now);
        this.commands = this.commands.filter(c => now - c.at < EMPTY_TTL_MS).slice(-511);
        this.commands.push({ key, at: now });
        this.bump();
        return result;
    }
    tick(now: number) {
        if (this.state.closed) return;
        let changed = false;
        const host = this.state.participants.find(p => p.profileId === this.state.hostId);
        if (host && !host.connected && host.disconnectedAt !== null && now >= host.disconnectedAt + WAIT_MS) {
            this.chooseHost(); changed = true;
        }
        if (this.state.barrier && now >= this.state.barrier.deadline) {
            for (const p of this.blockers()) p.excludedEpoch = this.state.syncEpoch;
            this.state.barrier = null;
            this.state.playback.updatedAt = now;
            this.settle(now); changed = true;
        }
        if (this.state.emptySince !== null && now >= this.state.emptySince + EMPTY_TTL_MS) {
            this.freeze(now); this.state.closed = true; this.state.barrier = null; changed = true;
        }
        if (changed) this.bump();
    }
    nextDeadline(): number | null {
        if (this.state.closed) return null;
        const deadlines: number[] = [];
        if (this.state.barrier) deadlines.push(this.state.barrier.deadline);
        if (this.state.emptySince !== null) deadlines.push(this.state.emptySince + EMPTY_TTL_MS);
        const host = this.state.participants.find(p => p.profileId === this.state.hostId);
        if (host && !host.connected && host.disconnectedAt !== null) deadlines.push(host.disconnectedAt + WAIT_MS);
        return deadlines.length ? Math.min(...deadlines) : null;
    }
}

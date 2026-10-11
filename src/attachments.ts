import { MAX_ATTACHMENT_BYTES, MAX_VOICE_DURATION_MS, type RoomAttachmentKind, type RoomChatMessage } from '../protocol/index.ts';
import { HttpError } from './auth.ts';

export const CHUNK_SIZE = 64 * 1024; // 64 KiB chunks for SQLite-backed DO storage

export type StoredAttachmentMeta = {
    id: string;
    roomId: string;
    kind: RoomAttachmentKind;
    mimeType: string;
    size: number;
    name: string;
    durationMs?: number;
    profileId: number;
    createdAt: number;
    chunkCount: number;
    messageId: string;
};

export type StoredUploadReceipt = {
    attachmentId: string;
    messageId: string;
    hash: string;
    kind: RoomAttachmentKind;
    name: string;
    text?: string;
};

/**
 * Sniff binary signatures for supported image and voice formats.
 * Rejects SVG, HTML, scripts, and arbitrary file contents.
 */
export function sniffMimeType(bytes: Uint8Array): { mimeType: string; kind: RoomAttachmentKind } | null {
    if (bytes.length < 4) return null;

    // Reject HTML/SVG / XML-like payloads
    const sampleSize = Math.min(bytes.length, 512);
    let sample = '';
    for (let i = 0; i < sampleSize; i++) {
        sample += String.fromCharCode(bytes[i]);
    }
    const lowerSample = sample.toLowerCase();
    if (
        lowerSample.includes('<svg') ||
        lowerSample.includes('<?xml') ||
        lowerSample.includes('<!doctype') ||
        lowerSample.includes('<html') ||
        lowerSample.includes('<body') ||
        lowerSample.includes('<script')
    ) {
        return null;
    }

    // 1. JPEG: FF D8 FF
    if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) {
        return { mimeType: 'image/jpeg', kind: 'image' };
    }

    // 2. PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        bytes.length >= 8 &&
        bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47 &&
        bytes[4] === 0x0D && bytes[5] === 0x0A && bytes[6] === 0x1A && bytes[7] === 0x0A
    ) {
        return { mimeType: 'image/png', kind: 'image' };
    }

    // 3. GIF: GIF87a or GIF89a
    if (
        bytes.length >= 6 &&
        bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    ) {
        return { mimeType: 'image/gif', kind: 'image' };
    }

    // 4. WebP: RIFF .... WEBP
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
        bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
        return { mimeType: 'image/webp', kind: 'image' };
    }

    // 5. EBML / Matroska / WebM: 1A 45 DF A3
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
        return { mimeType: 'audio/webm', kind: 'voice' };
    }

    // 6. Ogg: OggS
    if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
        return { mimeType: 'audio/ogg', kind: 'voice' };
    }

    // 7. ISO Base Media File Format (ftyp box at offset 4): AVIF or MP4 / M4A
    if (
        bytes.length >= 12 &&
        bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // 'ftyp'
    ) {
        const brands: string[] = [];
        const majorBrand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
        brands.push(majorBrand);

        const boxLen = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
        const maxOffset = Math.min(bytes.length, Math.max(16, boxLen > 0 ? boxLen : 64));
        for (let off = 16; off + 4 <= maxOffset; off += 4) {
            brands.push(String.fromCharCode(bytes[off], bytes[off + 1], bytes[off + 2], bytes[off + 3]));
        }

        if (brands.some(b => b === 'avif' || b === 'avis')) {
            return { mimeType: 'image/avif', kind: 'image' };
        }
        if (brands.some(b => b === 'M4A ' || b === 'mp41' || b === 'mp42' || b === 'isom' || b === 'dash')) {
            return { mimeType: 'audio/mp4', kind: 'voice' };
        }
    }

    return null;
}

/**
 * Reads an incoming stream with a strict byte limit.
 * Does not trust Content-Length header.
 */
export async function readBoundedStream(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
    if (!stream) throw new HttpError(400, 'EMPTY_ATTACHMENT');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let totalLength = 0;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
                totalLength += value.byteLength;
                // Retain at most maxBytes. Drain/discard excess input so the
                // HTTP connection can deliver a complete JSON 413 response.
                if (totalLength <= maxBytes) chunks.push(value);
            }
        }
        if (totalLength > maxBytes) throw new HttpError(413, 'BODY_TOO_LARGE');
    } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(400, 'READ_ERROR');
    } finally {
        reader.releaseLock();
    }

    if (totalLength === 0) {
        throw new HttpError(400, 'EMPTY_ATTACHMENT');
    }

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return combined;
}

/**
 * Computes SHA-256 hex digest for idempotency conflict detection.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Stores attachment metadata, chunked binary data, and idempotency receipt.
 */
export async function saveAttachment(
    storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>,
    meta: StoredAttachmentMeta,
    bytes: Uint8Array,
    uploadId: string,
    hash: string,
    text: string = '',
): Promise<void> {
    const chunkCount = Math.ceil(bytes.byteLength / CHUNK_SIZE);
    meta.chunkCount = chunkCount;

    const puts: Record<string, unknown> = {
        [`att:meta:${meta.id}`]: meta,
        [`att:upload:${meta.profileId}:${uploadId}`]: {
            attachmentId: meta.id,
            messageId: meta.messageId,
            hash,
            kind: meta.kind,
            name: meta.name,
            text,
        } satisfies StoredUploadReceipt,
    };

    for (let i = 0; i < chunkCount; i++) {
        const start = i * CHUNK_SIZE;
        const end = Math.min(bytes.byteLength, start + CHUNK_SIZE);
        puts[`att:chunk:${meta.id}:${i}`] = bytes.slice(start, end);
    }

    await storage.put(puts);
}

/**
 * Loads metadata and binary chunks for an attachment.
 */
export async function loadAttachment(
    storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>,
    attachmentId: string,
): Promise<{ meta: StoredAttachmentMeta; bytes: Uint8Array } | null> {
    const meta = await storage.get<StoredAttachmentMeta>(`att:meta:${attachmentId}`);
    if (!meta) return null;

    const chunkKeys: string[] = [];
    for (let i = 0; i < meta.chunkCount; i++) {
        chunkKeys.push(`att:chunk:${attachmentId}:${i}`);
    }

    const chunksMap = await storage.get<Uint8Array>(chunkKeys);
    const combined = new Uint8Array(meta.size);
    let offset = 0;
    for (let i = 0; i < meta.chunkCount; i++) {
        const chunk = chunksMap.get(`att:chunk:${attachmentId}:${i}`);
        if (!chunk) return null; // Corrupted / partial
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return { meta, bytes: combined };
}

/**
 * Retrieves an upload receipt by author and upload ID.
 */
export async function getUploadReceipt(
    storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>,
    profileId: number,
    uploadId: string,
): Promise<StoredUploadReceipt | null> {
    return (await storage.get<StoredUploadReceipt>(`att:upload:${profileId}:${uploadId}`)) ?? null;
}

/**
 * Cleans up attachments that have been evicted from the retained chat history (last 50 messages).
 */
export async function cleanEvictedAttachments(
    storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>,
    retainedChat: RoomChatMessage[],
): Promise<void> {
    const activeAttachmentIds = new Set<string>();
    for (const msg of retainedChat) {
        if (msg.attachment?.id) {
            activeAttachmentIds.add(msg.attachment.id);
        }
    }

    const metas = await storage.list<StoredAttachmentMeta>({ prefix: 'att:meta:' });
    for (const [key, meta] of metas.entries()) {
        if (!activeAttachmentIds.has(meta.id)) {
            const deleteKeys = [key];
            for (let i = 0; i < meta.chunkCount; i++) {
                deleteKeys.push(`att:chunk:${meta.id}:${i}`);
            }
            await storage.delete(deleteKeys);
        }
    }

    const receipts = await storage.list<StoredUploadReceipt>({ prefix: 'att:upload:' });
    for (const [rKey, receipt] of receipts.entries()) {
        if (!activeAttachmentIds.has(receipt.attachmentId)) {
            await storage.delete(rKey);
        }
    }
}

/**
 * Erases all attachment keys, chunks, metadata, receipts, and limits for the room.
 */
export async function eraseAllAttachmentData(storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>): Promise<void> {
    let cursor: string | undefined;
    while (true) {
        const batch = await storage.list<unknown>({
            prefix: 'att:',
            limit: 128,
            startAfter: cursor,
        });
        if (batch.size === 0) break;
        const keys = Array.from(batch.keys());
        await storage.delete(keys);
        cursor = keys[keys.length - 1];
    }
}

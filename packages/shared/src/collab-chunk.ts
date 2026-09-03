import { MAX_COLLAB_CHUNK_BYTES, MAX_COLLAB_UPDATE_BYTES } from './limits';

export const WS_MESSAGE_CHUNK = 4;
export const HTTP_SYNC_CHUNK_PROTOCOL = 'chunked';
export const HTTP_SYNC_PROTOCOL_HEADER = 'x-rdocs-sync-protocol';
export const HTTP_SYNC_CHUNK_ID_HEADER = 'x-rdocs-chunk-id';
export const HTTP_SYNC_CHUNK_INDEX_HEADER = 'x-rdocs-chunk-index';
export const HTTP_SYNC_CHUNK_COUNT_HEADER = 'x-rdocs-chunk-count';

const CHUNK_ID_BYTES = 8;
const WS_CHUNK_HEADER_BYTES = 1 + 1 + CHUNK_ID_BYTES + 2 + 2 + 4;

export type ChunkPushResult =
  | { status: 'complete'; payload: Uint8Array }
  | { status: 'pending'; received: number; count: number }
  | { status: 'error'; error: string };

export function splitBytes(
  payload: Uint8Array,
  chunkBytes: number = MAX_COLLAB_CHUNK_BYTES,
): Uint8Array[] {
  if (payload.byteLength === 0) return [payload];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < payload.byteLength; offset += chunkBytes) {
    chunks.push(payload.subarray(offset, Math.min(payload.byteLength, offset + chunkBytes)));
  }
  return chunks;
}

export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function randomChunkId(): Uint8Array {
  const id = new Uint8Array(CHUNK_ID_BYTES);
  crypto.getRandomValues(id);
  return id;
}

export function chunkIdToHex(id: Uint8Array): string {
  return [...id].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export function hexToChunkId(value: string): Uint8Array | null {
  if (!/^[0-9a-f]+$/i.test(value) || value.length !== CHUNK_ID_BYTES * 2) return null;
  const id = new Uint8Array(CHUNK_ID_BYTES);
  for (let index = 0; index < CHUNK_ID_BYTES; index += 1) {
    id[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return id;
}

function encodeWsChunkFrame(
  id: Uint8Array,
  index: number,
  count: number,
  payload: Uint8Array,
): Uint8Array {
  const frame = new Uint8Array(WS_CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(frame.buffer);
  frame[0] = WS_MESSAGE_CHUNK;
  frame[1] = id.byteLength;
  frame.set(id, 2);
  let offset = 2 + id.byteLength;
  view.setUint16(offset, index);
  offset += 2;
  view.setUint16(offset, count);
  offset += 2;
  view.setUint32(offset, payload.byteLength);
  offset += 4;
  frame.set(payload, offset);
  return frame;
}

export function encodeWsChunkFrames(
  payload: Uint8Array,
  chunkBytes: number = MAX_COLLAB_CHUNK_BYTES,
): Uint8Array[] {
  if (payload.byteLength <= chunkBytes) return [payload];
  const id = randomChunkId();
  const slices = splitBytes(payload, chunkBytes);
  return slices.map((slice, index) => encodeWsChunkFrame(id, index, slices.length, slice));
}

export type InspectedWsFrame =
  | { kind: 'plain' }
  | { kind: 'invalid' }
  | { kind: 'chunk'; id: string; index: number; count: number; payload: Uint8Array };

export function inspectWsFrame(bytes: Uint8Array): InspectedWsFrame {
  if (bytes.byteLength === 0) return { kind: 'invalid' };
  if (bytes[0] !== WS_MESSAGE_CHUNK) return { kind: 'plain' };
  if (bytes.byteLength < WS_CHUNK_HEADER_BYTES) return { kind: 'invalid' };
  const idLength = bytes[1] ?? 0;
  if (idLength !== CHUNK_ID_BYTES) return { kind: 'invalid' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const id = bytes.subarray(2, 2 + idLength);
  let offset = 2 + idLength;
  const index = view.getUint16(offset);
  offset += 2;
  const count = view.getUint16(offset);
  offset += 2;
  const length = view.getUint32(offset);
  offset += 4;
  if (index >= count || count === 0 || offset + length !== bytes.byteLength)
    return { kind: 'invalid' };
  return {
    kind: 'chunk',
    id: chunkIdToHex(id),
    index,
    count,
    payload: bytes.subarray(offset, offset + length),
  };
}

interface Transfer {
  parts: (Uint8Array | null)[];
  received: number;
  count: number;
  totalBytes: number;
  expiresAt: number;
}

export class ChunkAssembler {
  private readonly transfers = new Map<string, Transfer>();

  constructor(
    private readonly maxAssembledBytes: number = MAX_COLLAB_UPDATE_BYTES,
    private readonly maxChunkBytes: number = MAX_COLLAB_CHUNK_BYTES,
    private readonly maxTransfers: number = 8,
    private readonly ttlMs: number = 30_000,
  ) {}

  push(
    id: string,
    index: number,
    count: number,
    chunk: Uint8Array,
    now: number = Date.now(),
  ): ChunkPushResult {
    this.sweep(now);
    const maxCount = Math.max(
      1,
      Math.ceil(this.maxAssembledBytes / Math.max(1, this.maxChunkBytes)),
    );
    if (!id || count < 1 || count > maxCount || index < 0 || index >= count) {
      return { status: 'error', error: 'invalid_chunk' };
    }
    if (chunk.byteLength > this.maxChunkBytes) {
      return { status: 'error', error: 'chunk_too_large' };
    }

    let transfer = this.transfers.get(id);
    if (!transfer) {
      if (this.transfers.size >= this.maxTransfers) {
        return { status: 'error', error: 'too_many_transfers' };
      }
      transfer = {
        parts: new Array<Uint8Array | null>(count).fill(null),
        received: 0,
        count,
        totalBytes: 0,
        expiresAt: now + this.ttlMs,
      };
      this.transfers.set(id, transfer);
    } else if (transfer.count !== count) {
      this.transfers.delete(id);
      return { status: 'error', error: 'chunk_count_mismatch' };
    }

    if (transfer.parts[index]) {
      return { status: 'pending', received: transfer.received, count };
    }
    if (transfer.totalBytes + chunk.byteLength > this.maxAssembledBytes) {
      this.transfers.delete(id);
      return { status: 'error', error: 'assembled_too_large' };
    }

    transfer.parts[index] = chunk.slice();
    transfer.received += 1;
    transfer.totalBytes += chunk.byteLength;
    transfer.expiresAt = now + this.ttlMs;
    if (transfer.received < count) {
      return { status: 'pending', received: transfer.received, count };
    }

    const payload = concatBytes(transfer.parts as Uint8Array[]);
    this.transfers.delete(id);
    return { status: 'complete', payload };
  }

  reset(): void {
    this.transfers.clear();
  }

  sweep(now: number = Date.now()): void {
    for (const [id, transfer] of this.transfers) {
      if (transfer.expiresAt <= now) this.transfers.delete(id);
    }
  }
}

import { describe, expect, it } from 'vitest';

import {
  ChunkAssembler,
  concatBytes,
  encodeWsChunkFrames,
  inspectWsFrame,
  splitBytes,
  WS_MESSAGE_CHUNK,
} from './collab-chunk';
import { MAX_COLLAB_CHUNK_BYTES } from './limits';

describe('collaboration chunking', () => {
  it('leaves payloads at or under the chunk size untouched', () => {
    const payload = new Uint8Array(64).fill(7);
    expect(encodeWsChunkFrames(payload, 64)).toEqual([payload]);
    expect(inspectWsFrame(payload)).toEqual({ kind: 'plain' });
  });

  it('splits and reassembles large WebSocket payloads out of order', () => {
    const payload = new Uint8Array(MAX_COLLAB_CHUNK_BYTES * 2 + 17).map((_, index) => index % 251);
    const frames = encodeWsChunkFrames(payload, MAX_COLLAB_CHUNK_BYTES);
    expect(frames.length).toBe(3);
    expect(frames.every((frame) => frame[0] === WS_MESSAGE_CHUNK)).toBe(true);
    expect(frames.every((frame) => frame.byteLength <= MAX_COLLAB_CHUNK_BYTES + 32)).toBe(true);

    const assembler = new ChunkAssembler();
    const inspected = frames.map((frame) => inspectWsFrame(frame));
    expect(inspected.every((frame) => frame.kind === 'chunk')).toBe(true);
    const chunks = inspected.filter(
      (frame): frame is Extract<(typeof inspected)[number], { kind: 'chunk' }> =>
        frame.kind === 'chunk',
    );

    const first = assembler.push(
      chunks[1]!.id,
      chunks[1]!.index,
      chunks[1]!.count,
      chunks[1]!.payload,
    );
    expect(first.status).toBe('pending');
    const second = assembler.push(
      chunks[2]!.id,
      chunks[2]!.index,
      chunks[2]!.count,
      chunks[2]!.payload,
    );
    expect(second.status).toBe('pending');
    const complete = assembler.push(
      chunks[0]!.id,
      chunks[0]!.index,
      chunks[0]!.count,
      chunks[0]!.payload,
    );
    expect(complete).toEqual({ status: 'complete', payload });
  });

  it('rejects oversized assembled payloads', () => {
    const assembler = new ChunkAssembler(100, 60, 4, 30_000);
    const id = 'aa'.repeat(8);
    expect(assembler.push(id, 0, 2, new Uint8Array(60).fill(1))).toEqual({
      status: 'pending',
      received: 1,
      count: 2,
    });
    expect(assembler.push(id, 1, 2, new Uint8Array(50).fill(2)).status).toBe('error');
  });

  it('concatenates split bytes back to the original payload', () => {
    const payload = new Uint8Array(200).map((_, index) => index);
    expect(concatBytes(splitBytes(payload, 64))).toEqual(payload);
  });
});

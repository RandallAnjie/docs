import { afterEach, describe, expect, it, vi } from 'vitest';

import { inspectWsFrame, MAX_COLLAB_CHUNK_BYTES } from '@rdocs/shared';

import { ChunkingWebSocket } from './chunking-websocket';

class FakeSocket {
  binaryType: BinaryType = 'blob';
  readyState = 1;
  sent: ArrayBuffer[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  url = 'wss://docs.example/collab';
  protocol = '';
  extensions = '';
  bufferedAmount = 0;

  send(data: ArrayBuffer): void {
    this.sent.push(data);
  }

  close(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  dispatchEvent(): boolean {
    return true;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ChunkingWebSocket', () => {
  it('splits a large outbound frame into chunk-sized WebSocket messages', () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const socket = new ChunkingWebSocket('wss://docs.example/collab');
    const inner = (socket as unknown as { socket: FakeSocket }).socket;
    const payload = new Uint8Array(MAX_COLLAB_CHUNK_BYTES + 90).fill(9);
    socket.send(payload);
    expect(inner.sent.length).toBe(2);
    expect(inner.sent.every((frame) => frame.byteLength <= MAX_COLLAB_CHUNK_BYTES + 32)).toBe(true);
    expect(inspectWsFrame(new Uint8Array(inner.sent[0]!)).kind).toBe('chunk');
  });

  it('reassembles inbound chunk frames before emitting a message', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    const socket = new ChunkingWebSocket('wss://docs.example/collab');
    const inner = (socket as unknown as { socket: FakeSocket }).socket;
    const payload = new Uint8Array(MAX_COLLAB_CHUNK_BYTES + 12).map((_, index) => index % 200);
    socket.send(payload);
    const received = new Promise<ArrayBuffer>((resolve) => {
      socket.onmessage = (event) => resolve(event.data as ArrayBuffer);
    });
    for (const frame of inner.sent) {
      inner.onmessage?.(new MessageEvent('message', { data: frame }));
    }
    expect(new Uint8Array(await received)).toEqual(payload);
  });
});

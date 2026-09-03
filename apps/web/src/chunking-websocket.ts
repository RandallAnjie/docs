import { encodeWsChunkFrames, inspectWsFrame, ChunkAssembler } from '@rdocs/shared';

function toBytes(data: unknown): Uint8Array | null {
  if (typeof data === 'string') return null;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * y-websocket compatible WebSocket that splits large binary frames and
 * reassembles inbound chunked frames before handing them to the provider.
 */
export class ChunkingWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  private readonly socket: WebSocket;
  private readonly assembler = new ChunkAssembler();
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.socket = new WebSocket(url, protocols);
    this.socket.binaryType = 'arraybuffer';
    this.socket.onopen = (event) => this.onopen?.(event);
    this.socket.onerror = (event) => this.onerror?.(event);
    this.socket.onclose = (event) => {
      this.assembler.reset();
      this.onclose?.(event);
    };
    this.socket.onmessage = (event) => {
      const bytes = toBytes(event.data);
      if (!bytes) {
        this.onmessage?.(event);
        return;
      }
      const inspected = inspectWsFrame(bytes);
      if (inspected.kind === 'plain') {
        this.onmessage?.(new MessageEvent('message', { data: toArrayBuffer(bytes) }));
        return;
      }
      if (inspected.kind === 'invalid') {
        this.socket.close(4400, 'invalid_chunk');
        return;
      }
      const result = this.assembler.push(
        inspected.id,
        inspected.index,
        inspected.count,
        inspected.payload,
      );
      if (result.status === 'error') {
        this.socket.close(4400, result.error);
        return;
      }
      if (result.status === 'pending') return;
      this.onmessage?.(new MessageEvent('message', { data: toArrayBuffer(result.payload) }));
    };
  }

  get url(): string {
    return this.socket.url;
  }

  get protocol(): string {
    return this.socket.protocol;
  }

  get extensions(): string {
    return this.socket.extensions;
  }

  get readyState(): number {
    return this.socket.readyState;
  }

  get bufferedAmount(): number {
    return this.socket.bufferedAmount;
  }

  get binaryType(): BinaryType {
    return this.socket.binaryType;
  }

  set binaryType(value: BinaryType) {
    this.socket.binaryType = value;
  }

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    if (typeof data === 'string' || data instanceof Blob) {
      this.socket.send(data);
      return;
    }
    const bytes = toBytes(data);
    if (!bytes) {
      this.socket.send(data as ArrayBuffer);
      return;
    }
    for (const frame of encodeWsChunkFrames(bytes)) {
      this.socket.send(toArrayBuffer(frame));
    }
  }

  close(code?: number, reason?: string): void {
    this.socket.close(code, reason);
  }

  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void {
    this.socket.addEventListener(type, listener, options);
  }

  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ): void {
    this.socket.removeEventListener(type, listener, options);
  }

  dispatchEvent(event: Event): boolean {
    return this.socket.dispatchEvent(event);
  }
}

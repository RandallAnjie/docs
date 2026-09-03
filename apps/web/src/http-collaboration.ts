import {
  decodeHttpSyncResponse,
  encodeHttpSyncRequest,
  HTTP_SYNC_CHUNK_COUNT_HEADER,
  HTTP_SYNC_CHUNK_ID_HEADER,
  HTTP_SYNC_CHUNK_INDEX_HEADER,
  HTTP_SYNC_CHUNK_PROTOCOL,
  HTTP_SYNC_FIELD_TOO_LARGE,
  HTTP_SYNC_PROTOCOL_HEADER,
  MAX_COLLAB_CHUNK_BYTES,
  splitBytes,
  type HttpSyncResponse,
} from '@rdocs/shared';
import { applyAwarenessUpdate, type Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';

export type HttpCollaborationState = 'synced' | 'disconnected' | 'forbidden' | 'rebased';

interface HttpCollaborationOptions {
  pageId: string;
  document: Y.Doc;
  awareness: Awareness;
  ticket: string;
  renewTicket: () => Promise<string>;
  onState: (state: HttpCollaborationState) => void;
  pollIntervalMs?: number;
  syncUrl?: string;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export class HttpCollaborationTransport {
  private readonly document: Y.Doc;
  private readonly awareness: Awareness;
  private readonly renewTicket: () => Promise<string>;
  private readonly onState: (state: HttpCollaborationState) => void;
  private readonly pollIntervalMs: number;
  private readonly syncUrl: string;
  private ticket: string;
  private knownServerStateVector: Uint8Array = new Uint8Array([0]);
  private timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  private timerDeadline = Number.POSITIVE_INFINITY;
  private failures = 0;
  private renewedAfterAuthorizationFailure = false;
  private running = false;
  private syncAgain = false;
  private stopped = true;
  private abortController: AbortController | undefined;

  constructor(options: HttpCollaborationOptions) {
    this.document = options.document;
    this.awareness = options.awareness;
    this.ticket = options.ticket;
    this.renewTicket = options.renewTicket;
    this.onState = options.onState;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_500;
    this.syncUrl =
      options.syncUrl ?? `/api/pages/${encodeURIComponent(options.pageId)}/collaboration-sync`;
  }

  start(): Promise<void> {
    if (!this.stopped) return Promise.resolve();
    this.stopped = false;
    this.document.on('update', this.handleDocumentUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibility);
    }
    return this.syncNow();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.document.off('update', this.handleDocumentUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibility);
    }
    globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDeadline = Number.POSITIVE_INFINITY;
    this.abortController?.abort();
  }

  async flushNow(): Promise<void> {
    while (this.running && !this.stopped) {
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 10));
    }
    if (!this.stopped) await this.syncNow();
  }

  async syncNow(): Promise<void> {
    if (this.stopped) return;
    globalThis.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDeadline = Number.POSITIVE_INFINITY;
    if (this.running) {
      this.syncAgain = true;
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    try {
      const response = await this.sendSyncRequest();
      if (
        (response.status === 401 || response.status === 403) &&
        !this.renewedAfterAuthorizationFailure
      ) {
        try {
          this.ticket = await this.renewTicket();
          this.renewedAfterAuthorizationFailure = true;
          this.failures = 0;
          this.schedule(0);
          return;
        } catch {
          this.onState('forbidden');
          this.stop();
          return;
        }
      }
      if (response.status === 403) {
        this.onState('forbidden');
        this.stop();
        return;
      }
      if (response.status === 409 && response.headers.has('x-rdocs-document-generation')) {
        this.onState('rebased');
        this.stop();
        return;
      }
      if (response.status === 413) {
        this.syncAgain = false;
        this.onState('disconnected');
        this.schedule(15_000);
        return;
      }
      if (response.status === 202 || !response.ok) throw new Error(`http_sync_${response.status}`);

      const payload = decodeHttpSyncResponse(new Uint8Array(await response.arrayBuffer()));
      this.applyResponse(payload);
      this.failures = 0;
      this.renewedAfterAuthorizationFailure = false;
      this.onState('synced');
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      this.schedule(hidden ? Math.max(8_000, this.pollIntervalMs) : this.pollIntervalMs);
    } catch (reason) {
      if (this.stopped || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      const tooLarge =
        reason instanceof Error &&
        (reason.message === HTTP_SYNC_FIELD_TOO_LARGE || reason.message === 'http_sync_413');
      if (tooLarge) this.syncAgain = false;
      this.failures += 1;
      if (this.failures >= 3 || tooLarge) this.onState('disconnected');
      this.schedule(tooLarge ? 15_000 : Math.min(250 * 2 ** (this.failures - 1), 2_000));
    } finally {
      this.running = false;
      this.abortController = undefined;
      if (this.syncAgain && !this.stopped) {
        this.syncAgain = false;
        this.schedule(25);
      }
    }
  }

  private readonly handleVisibility = (): void => {
    if (typeof document === 'undefined' || this.stopped) return;
    if (document.visibilityState === 'hidden') {
      this.schedule(Math.max(8_000, this.pollIntervalMs));
      return;
    }
    this.schedule(0);
  };

  private readonly handleDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin !== this) this.schedule(25);
  };

  private readonly handleAwarenessUpdate = (
    _changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin !== this) this.schedule(400);
  };

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    const deadline = Date.now() + delayMs;
    if (this.timer !== undefined && deadline >= this.timerDeadline) return;
    globalThis.clearTimeout(this.timer);
    this.timerDeadline = deadline;
    this.timer = globalThis.setTimeout(() => {
      this.timer = undefined;
      this.timerDeadline = Number.POSITIVE_INFINITY;
      void this.syncNow();
    }, delayMs);
  }

  private sendSyncRequest(): Promise<Response> {
    const localState = this.awareness.getLocalState();
    const body = encodeHttpSyncRequest({
      clientStateVector: Y.encodeStateVector(this.document),
      clientUpdate: Y.encodeStateAsUpdate(this.document, this.knownServerStateVector),
      awarenessUpdate: localState
        ? encodeAwarenessUpdate(this.awareness, [this.awareness.clientID])
        : new Uint8Array(),
    });
    if (body.byteLength <= MAX_COLLAB_CHUNK_BYTES) return this.postSync(body);
    return this.postChunkedSync(body);
  }

  private postSync(body: Uint8Array, extraHeaders?: Record<string, string>): Promise<Response> {
    return fetch(this.syncUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.ticket}`,
        'content-type': 'application/octet-stream',
        ...extraHeaders,
      },
      body: toArrayBuffer(body),
      signal: this.abortController?.signal,
    });
  }

  private async postChunkedSync(body: Uint8Array): Promise<Response> {
    const id = crypto.randomUUID();
    const chunks = splitBytes(body, MAX_COLLAB_CHUNK_BYTES);
    const responses = await Promise.all(
      chunks.map((chunk, index) =>
        this.postSync(chunk, {
          [HTTP_SYNC_PROTOCOL_HEADER]: HTTP_SYNC_CHUNK_PROTOCOL,
          [HTTP_SYNC_CHUNK_ID_HEADER]: id,
          [HTTP_SYNC_CHUNK_INDEX_HEADER]: String(index),
          [HTTP_SYNC_CHUNK_COUNT_HEADER]: String(chunks.length),
        }),
      ),
    );
    const failed = responses.find((response) => !response.ok && response.status !== 202);
    const completed = responses.find((response) => response.status === 200);
    for (const response of responses) {
      if (response !== failed && response !== completed && response.body) {
        void response.body.cancel().catch(() => undefined);
      }
    }
    if (failed) return failed;
    if (completed) return completed;
    return responses[responses.length - 1] ?? new Response(null, { status: 503 });
  }

  private applyResponse(response: HttpSyncResponse): void {
    if (response.serverUpdate.byteLength > 0) {
      Y.applyUpdate(this.document, response.serverUpdate, this);
    }
    this.knownServerStateVector = response.serverStateVector;
    if (response.awarenessUpdate.byteLength > 0) {
      applyAwarenessUpdate(this.awareness, response.awarenessUpdate, this);
    }
  }
}

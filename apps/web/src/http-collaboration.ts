import {
  decodeHttpSyncResponse,
  encodeHttpSyncRequest,
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
    this.pollIntervalMs = options.pollIntervalMs ?? 350;
    this.syncUrl =
      options.syncUrl ?? `/api/pages/${encodeURIComponent(options.pageId)}/collaboration-sync`;
  }

  start(): Promise<void> {
    if (!this.stopped) return Promise.resolve();
    this.stopped = false;
    this.document.on('update', this.handleDocumentUpdate);
    this.awareness.on('update', this.handleAwarenessUpdate);
    return this.syncNow();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.document.off('update', this.handleDocumentUpdate);
    this.awareness.off('update', this.handleAwarenessUpdate);
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
      if (!response.ok) throw new Error(`http_sync_${response.status}`);

      const payload = decodeHttpSyncResponse(new Uint8Array(await response.arrayBuffer()));
      this.applyResponse(payload);
      this.failures = 0;
      this.renewedAfterAuthorizationFailure = false;
      this.onState('synced');
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      this.schedule(hidden ? 1_500 : this.pollIntervalMs);
    } catch (reason) {
      if (this.stopped || (reason instanceof DOMException && reason.name === 'AbortError')) return;
      this.failures += 1;
      if (this.failures >= 3) this.onState('disconnected');
      this.schedule(Math.min(250 * 2 ** (this.failures - 1), 2_000));
    } finally {
      this.running = false;
      this.abortController = undefined;
      if (this.syncAgain && !this.stopped) {
        this.syncAgain = false;
        this.schedule(25);
      }
    }
  }

  private readonly handleDocumentUpdate = (_update: Uint8Array, origin: unknown): void => {
    if (origin !== this) this.schedule(25);
  };

  private readonly handleAwarenessUpdate = (
    _changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin !== this) this.schedule(25);
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
    return fetch(this.syncUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.ticket}`,
        'content-type': 'application/octet-stream',
      },
      body: toArrayBuffer(body),
      signal: this.abortController?.signal,
    });
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

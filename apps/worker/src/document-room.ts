import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import { MAX_COLLAB_FRAME_BYTES } from '@rdocs/shared';

import type { Env } from './env';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const SNAPSHOT_UPDATE_COUNT = 100;
const SNAPSHOT_BYTE_COUNT = 512 * 1024;

interface SocketAttachment {
  actorId: string;
  displayName: string;
  role: 'editor' | 'viewer';
  pageId: string;
  generation: number;
  aclVersion: number;
  awarenessClientIds: number[];
}

interface SnapshotRow {
  seq: number;
  state_blob: string;
}

interface UpdateRow {
  seq: number;
  update_blob: string;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function syncMessage(subtype: number, payload: Uint8Array): Uint8Array {
  const output = encoding.createEncoder();
  encoding.writeVarUint(output, MESSAGE_SYNC);
  encoding.writeVarUint(output, subtype);
  encoding.writeVarUint8Array(output, payload);
  return encoding.toUint8Array(output);
}

function awarenessMessage(payload: Uint8Array): Uint8Array {
  const output = encoding.createEncoder();
  encoding.writeVarUint(output, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(output, payload);
  return encoding.toUint8Array(output);
}

function awarenessClientIds(payload: Uint8Array): number[] {
  const decoder = decoding.createDecoder(payload);
  const count = decoding.readVarUint(decoder);
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(decoding.readVarUint(decoder));
    decoding.readVarUint(decoder);
    decoding.readVarString(decoder);
  }
  return ids;
}

async function normalizeBinaryMessage(rawMessage: unknown): Promise<Uint8Array | null> {
  if (typeof rawMessage === 'string') return null;
  if (rawMessage instanceof ArrayBuffer) return new Uint8Array(rawMessage);
  if (ArrayBuffer.isView(rawMessage)) {
    return new Uint8Array(rawMessage.buffer, rawMessage.byteOffset, rawMessage.byteLength);
  }
  if (rawMessage instanceof Blob) return new Uint8Array(await rawMessage.arrayBuffer());
  throw new Error('unsupported_websocket_message_type');
}

export class DocumentRoom {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private readonly document = new Y.Doc();
  private readonly awareness = new Awareness(this.document);
  private readonly ready: Promise<void>;
  private currentSeq = 0;
  private updatesSinceSnapshot = 0;
  private bytesSinceSnapshot = 0;
  private editingEnabled = true;
  private readonly sockets = new Set<WebSocket>();
  private readonly attachments = new WeakMap<WebSocket, SocketAttachment>();
  private messageQueue: Promise<void> = Promise.resolve();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {
      await this.initializeStorage();
      await this.restoreDocument();
    });

    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      const changed = added.concat(updated, removed);
      if (changed.length === 0) return;
      const message = awarenessMessage(encodeAwarenessUpdate(this.awareness, changed));
      this.broadcast(message, origin instanceof WebSocket ? origin : undefined);
    });
  }

  private async initializeStorage(): Promise<void> {
    await this.state.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS room_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    );
    await this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS updates (
        seq INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        update_blob TEXT NOT NULL,
        byte_size INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await this.state.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        state_blob TEXT NOT NULL,
        state_vector TEXT NOT NULL,
        kind TEXT NOT NULL,
        created_by TEXT,
        created_at INTEGER NOT NULL
      )`,
    );
    await this.state.storage.sql.exec(
      'CREATE INDEX IF NOT EXISTS idx_snapshots_seq ON snapshots(seq DESC)',
    );
  }

  private async restoreDocument(): Promise<void> {
    const snapshots = (await this.state.storage.sql
      .exec('SELECT seq, state_blob FROM snapshots ORDER BY seq DESC LIMIT 1')
      .toArray()) as unknown as SnapshotRow[];
    const snapshot = snapshots[0];
    if (snapshot) {
      Y.applyUpdate(this.document, base64ToBytes(snapshot.state_blob), 'restore');
      this.currentSeq = Number(snapshot.seq);
    }

    const updates = (await this.state.storage.sql
      .exec('SELECT seq, update_blob FROM updates WHERE seq > ? ORDER BY seq ASC', this.currentSeq)
      .toArray()) as unknown as UpdateRow[];
    for (const update of updates) {
      Y.applyUpdate(this.document, base64ToBytes(update.update_blob), 'restore');
      this.currentSeq = Number(update.seq);
    }
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handleFetch(request);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error(
        JSON.stringify({ level: 'error', event: 'document_room_fetch_failed', message }),
      );
      return new Response(`rdocs_do_error:${message}`.slice(0, 500), { status: 500 });
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === '/internal/access' && request.method === 'POST') {
      const body = (await request.json()) as { enabled?: boolean };
      this.editingEnabled = body.enabled === true;
      if (!this.editingEnabled) {
        for (const socket of this.sockets) {
          try {
            socket.close(4403, 'permission_changed');
          } catch {
            // Socket already closed.
          }
        }
      }
      return Response.json({ ok: true, enabled: this.editingEnabled });
    }

    if (url.pathname === '/internal/snapshot' && request.method === 'POST') {
      await this.createSnapshot('manual');
      return Response.json({ ok: true, seq: this.currentSeq });
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    if (request.headers.get('x-rdocs-editing-enabled') !== '1') {
      return new Response('Collaboration is disabled', { status: 403 });
    }
    this.editingEnabled = true;

    const attachment: SocketAttachment = {
      actorId: request.headers.get('x-rdocs-actor-id') ?? 'unknown',
      displayName: request.headers.get('x-rdocs-display-name') ?? 'Unknown',
      role: request.headers.get('x-rdocs-role') === 'viewer' ? 'viewer' : 'editor',
      pageId: request.headers.get('x-rdocs-page-id') ?? '',
      generation: Number(request.headers.get('x-rdocs-generation') ?? 1),
      aclVersion: Number(request.headers.get('x-rdocs-acl-version') ?? 1),
      awarenessClientIds: [],
    };

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);
    this.attachments.set(server, attachment);
    server.addEventListener('message', (event) => {
      this.messageQueue = this.messageQueue
        .then(() => this.webSocketMessage(server, event.data))
        .catch((reason) => {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'collaboration_message_queue_failed',
              message: reason instanceof Error ? reason.message : String(reason),
            }),
          );
        });
      this.state.waitUntil(this.messageQueue);
    });
    server.addEventListener('close', () => {
      this.state.waitUntil(this.webSocketClose(server));
    });
    server.addEventListener('error', () => {
      this.webSocketError(server);
    });

    server.send(syncMessage(SYNC_STEP_1, Y.encodeStateVector(this.document)));
    const currentClients = [...this.awareness.getStates().keys()];
    if (currentClients.length > 0) {
      server.send(awarenessMessage(encodeAwarenessUpdate(this.awareness, currentClients)));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: unknown): Promise<void> {
    await this.ready;
    const message = await normalizeBinaryMessage(rawMessage);
    if (!message) return;
    if (message.byteLength > MAX_COLLAB_FRAME_BYTES) {
      socket.close(4409, 'frame_too_large');
      return;
    }

    try {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        await this.handleSyncMessage(socket, decoder);
      } else if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        this.rememberAwarenessClients(socket, awarenessClientIds(update));
        applyAwarenessUpdate(this.awareness, update, socket);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'collaboration_frame_failed',
          message,
        }),
      );
      socket.close(4400, 'invalid_collaboration_frame');
    }
  }

  private async handleSyncMessage(socket: WebSocket, decoder: decoding.Decoder): Promise<void> {
    const subtype = decoding.readVarUint(decoder);
    if (subtype === SYNC_STEP_1) {
      const stateVector = decoding.readVarUint8Array(decoder);
      socket.send(syncMessage(SYNC_STEP_2, Y.encodeStateAsUpdate(this.document, stateVector)));
      return;
    }

    if (subtype !== SYNC_STEP_2 && subtype !== SYNC_UPDATE) return;
    const attachment = this.attachments.get(socket);
    if (!this.editingEnabled || attachment?.role !== 'editor') {
      socket.close(4403, 'permission_changed');
      return;
    }

    const update = decoding.readVarUint8Array(decoder);
    if (update.byteLength > MAX_COLLAB_FRAME_BYTES) {
      socket.close(4409, 'update_too_large');
      return;
    }

    await this.persistUpdate(update, attachment.actorId);
    Y.applyUpdate(this.document, update, socket);
    this.broadcast(syncMessage(SYNC_UPDATE, update), socket);
    await this.maybeCreateSnapshot();
  }

  private async persistUpdate(update: Uint8Array, actorId: string): Promise<void> {
    const nextSeq = this.currentSeq + 1;
    await this.state.storage.sql.exec(
      `INSERT INTO updates(seq, event_id, actor_id, update_blob, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      nextSeq,
      crypto.randomUUID(),
      actorId,
      bytesToBase64(update),
      update.byteLength,
      Date.now(),
    );
    this.currentSeq = nextSeq;
    this.updatesSinceSnapshot += 1;
    this.bytesSinceSnapshot += update.byteLength;
  }

  private async maybeCreateSnapshot(): Promise<void> {
    if (
      this.updatesSinceSnapshot < SNAPSHOT_UPDATE_COUNT &&
      this.bytesSinceSnapshot < SNAPSHOT_BYTE_COUNT
    ) {
      return;
    }
    await this.createSnapshot('automatic');
  }

  private async createSnapshot(kind: 'automatic' | 'manual'): Promise<void> {
    const state = Y.encodeStateAsUpdate(this.document);
    const vector = Y.encodeStateVector(this.document);
    await this.state.storage.sql.exec(
      `INSERT INTO snapshots(id, seq, state_blob, state_vector, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      this.currentSeq,
      bytesToBase64(state),
      bytesToBase64(vector),
      kind,
      null,
      Date.now(),
    );
    this.updatesSinceSnapshot = 0;
    this.bytesSinceSnapshot = 0;
  }

  private rememberAwarenessClients(socket: WebSocket, ids: number[]): void {
    const attachment = this.attachments.get(socket);
    if (!attachment) return;
    attachment.awarenessClientIds = [...new Set([...attachment.awarenessClientIds, ...ids])];
    this.attachments.set(socket, attachment);
  }

  private broadcast(message: Uint8Array, except?: WebSocket): void {
    for (const socket of this.sockets) {
      if (socket === except) continue;
      try {
        socket.send(message);
      } catch {
        // Runtime will deliver a close/error callback if the socket is stale.
      }
    }
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    this.sockets.delete(socket);
    const attachment = this.attachments.get(socket);
    if (attachment?.awarenessClientIds.length) {
      removeAwarenessStates(this.awareness, attachment.awarenessClientIds, socket);
    }
    if (this.sockets.size === 0 && this.updatesSinceSnapshot > 0) {
      await this.createSnapshot('automatic');
    }
  }

  webSocketError(socket: WebSocket): void {
    this.sockets.delete(socket);
    const attachment = this.attachments.get(socket);
    if (attachment?.awarenessClientIds.length) {
      removeAwarenessStates(this.awareness, attachment.awarenessClientIds, socket);
    }
  }
}

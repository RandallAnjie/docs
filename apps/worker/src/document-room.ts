import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
  removeAwarenessStates,
} from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  ChunkAssembler,
  decodeHttpSyncRequest,
  encodeHttpSyncResponse,
  encodeWsChunkFrames,
  HTTP_SYNC_CHUNK_COUNT_HEADER,
  HTTP_SYNC_CHUNK_ID_HEADER,
  HTTP_SYNC_CHUNK_INDEX_HEADER,
  HTTP_SYNC_CHUNK_PROTOCOL,
  HTTP_SYNC_FIELD_TOO_LARGE,
  HTTP_SYNC_PROTOCOL_HEADER,
  inspectWsFrame,
  MAX_COLLAB_CHUNK_BYTES,
  MAX_COLLAB_UPDATE_BYTES,
  MAX_HTTP_SYNC_BODY_BYTES,
  MAX_REVISION_SNAPSHOT_BYTES,
  MAX_UNCHUNKED_HTTP_SYNC_BYTES,
} from '@rdocs/shared';

import type { Env } from './env';
import { deliverPageUpdateNotifications } from './comments';
import { documentPlainText, normalizeSearchText, searchIndexText } from './search-projection';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;
const SNAPSHOT_UPDATE_COUNT = 100;
const SNAPSHOT_BYTE_COUNT = 512 * 1024;
const HTTP_AWARENESS_TIMEOUT_MS = 10_000;
const AUTOMATIC_REVISION_INTERVAL_MS = 15 * 60 * 1_000;
const EDITING_SESSION_IDLE_MS = 30 * 60 * 1_000;
const AUTOMATIC_REVISION_RETRY_MS = 60_000;
const SEARCH_PROJECTION_INTERVAL_MS = 1_500;
const MAX_COLLABORATORS = 100;
const MIN_AWARENESS_INTERVAL_MS = 50;

interface SocketAttachment {
  actorId: string;
  displayName: string;
  role: 'editor' | 'viewer';
  pageId: string;
  generation: number;
  aclVersion: number;
  awarenessClientIds: number[];
  lastAwarenessAt: number;
  resourceKind: 'page' | 'synced_block';
}

interface SnapshotRow {
  id?: string;
  seq: number;
  state_blob: string | Uint8Array | ArrayBuffer;
}

interface SnapshotArtifact {
  id: string;
  seq: number;
  state: Uint8Array;
  stateVector: Uint8Array;
  contentHash: string;
}

interface UpdateRow {
  seq: number;
  update_blob: string | Uint8Array | ArrayBuffer;
}

interface AwarenessChange {
  added: number[];
  updated: number[];
  removed: number[];
}

interface RoomMetaRow {
  value: string;
}

interface RevisionPageRow {
  organization_id: string;
  current_generation: number;
}

interface SearchPageRow extends RevisionPageRow {
  space_id: string;
  title: string;
}

/** RandallFlare DO SQL is JSON over HTTP with an 8 MiB body cap. */
const MAX_DO_SQL_TEXT_BYTES = 6 * 1024 * 1024;

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

export function encodeStoredBytes(bytes: Uint8Array): string {
  const encoded = bytesToBase64(bytes);
  if (encoded.length > MAX_DO_SQL_TEXT_BYTES) throw new Error(HTTP_SYNC_FIELD_TOO_LARGE);
  return encoded;
}

export function decodeStoredBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') {
    try {
      return base64ToBytes(value);
    } catch {
      throw new Error('invalid_stored_blob');
    }
  }
  throw new Error('invalid_stored_blob');
}

function createChunkAssembler(): ChunkAssembler {
  return new ChunkAssembler(MAX_COLLAB_UPDATE_BYTES, MAX_COLLAB_CHUNK_BYTES, 8, 30_000);
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

export function collaborationRoleCanEdit(role: string | null): boolean {
  return role === 'space_admin' || role === 'editor';
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function containsYjsChanges(update: Uint8Array): boolean {
  if (update.byteLength === 0) return false;
  const decoded = Y.decodeUpdate(update);
  return decoded.structs.length > 0 || decoded.ds.clients.size > 0;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

export function yjsUpdateChangesDocument(document: Y.Doc, update: Uint8Array): boolean {
  if (!containsYjsChanges(update)) return false;
  const missing = Y.diffUpdate(update, Y.encodeStateVector(document));
  const decoded = Y.decodeUpdate(missing);
  if (decoded.structs.length > 0) return true;
  if (decoded.ds.clients.size === 0) return false;

  const before = Y.encodeStateAsUpdate(document);
  // Cloning a large document just to detect a no-op delete set is more expensive
  // than persisting the rare no-op, and it is what wedged isolate CPU on big pastes.
  if (before.byteLength > 128 * 1024) return true;
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, before);
    Y.applyUpdate(candidate, update);
    return !equalBytes(before, Y.encodeStateAsUpdate(candidate));
  } finally {
    candidate.destroy();
  }
}

export function documentSyncedBlockIds(document: Y.Doc): string[] {
  let fragment: Y.XmlFragment;
  try {
    fragment = document.getXmlFragment('default');
  } catch {
    return [];
  }
  const ids = new Set<string>();
  const visit = (type: Y.XmlFragment | Y.XmlElement) => {
    for (const child of type.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'syncedBlock') {
        const id = child.getAttribute('syncedBlockId') ?? '';
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) ids.add(id);
      }
      visit(child);
    }
  };
  visit(fragment);
  return [...ids].sort();
}

export function documentSyncedBlockResourceIds(document: Y.Doc): string[] {
  let fragment: Y.XmlFragment;
  try {
    fragment = document.getXmlFragment('default');
  } catch {
    return [];
  }
  const ids = new Set<string>();
  const visit = (type: Y.XmlFragment | Y.XmlElement) => {
    for (const child of type.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'syncedBlock' || child.nodeName === 'deletedSyncedBlock') {
        const id = child.getAttribute('syncedBlockId') ?? '';
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) ids.add(id);
      }
      visit(child);
    }
  };
  visit(fragment);
  return [...ids].sort();
}

export function documentDeletedSyncedBlockCount(
  document: Y.Doc,
  blockId: string,
  operationId: string,
): number {
  let fragment: Y.XmlFragment;
  try {
    fragment = document.getXmlFragment('default');
  } catch {
    return 0;
  }
  let count = 0;
  const visit = (type: Y.XmlFragment | Y.XmlElement) => {
    for (const child of type.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (
        child.nodeName === 'deletedSyncedBlock' &&
        child.getAttribute('syncedBlockId') === blockId &&
        child.getAttribute('deletionOperationId') === operationId
      ) {
        count += 1;
      }
      visit(child);
    }
  };
  visit(fragment);
  return count;
}

export function documentPageLinkIds(document: Y.Doc): string[] {
  let fragment: Y.XmlFragment;
  try {
    fragment = document.getXmlFragment('default');
  } catch {
    return [];
  }
  const ids = new Set<string>();
  const visit = (type: Y.XmlFragment | Y.XmlElement) => {
    for (const child of type.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (child.nodeName === 'pageLink') {
        const id = child.getAttribute('pageId') ?? '';
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(id)) ids.add(id);
      }
      visit(child);
    }
  };
  visit(fragment);
  return [...ids].sort();
}

export function documentContainsSyncedBlock(document: Y.Doc): boolean {
  let fragment: Y.XmlFragment;
  try {
    fragment = document.getXmlFragment('default');
  } catch {
    return false;
  }
  const visit = (type: Y.XmlFragment | Y.XmlElement): boolean => {
    for (const child of type.toArray()) {
      if (!(child instanceof Y.XmlElement)) continue;
      if (
        child.nodeName === 'syncedBlock' ||
        child.nodeName === 'deletedSyncedBlock' ||
        visit(child)
      )
        return true;
    }
    return false;
  };
  return visit(fragment);
}

export function syncedBlockUnsyncUpdate(
  target: Y.Doc,
  blockId: string,
  sourceSnapshot: Uint8Array,
): { replacements: number; update: Uint8Array } {
  const working = new Y.Doc();
  const source = new Y.Doc();
  try {
    Y.applyUpdate(working, Y.encodeStateAsUpdate(target), 'unsync-working-copy');
    Y.applyUpdate(source, sourceSnapshot, 'unsync-source');
    const sourceChildren = source
      .getXmlFragment('default')
      .toArray()
      .filter(
        (child): child is Y.XmlElement | Y.XmlText =>
          child instanceof Y.XmlElement || child instanceof Y.XmlText,
      );
    const targets: Array<{ index: number; parent: Y.XmlElement | Y.XmlFragment }> = [];
    const visit = (parent: Y.XmlElement | Y.XmlFragment) => {
      parent.toArray().forEach((child, index) => {
        if (!(child instanceof Y.XmlElement)) return;
        if (child.nodeName === 'syncedBlock' && child.getAttribute('syncedBlockId') === blockId) {
          targets.push({ index, parent });
          return;
        }
        visit(child);
      });
    };
    visit(working.getXmlFragment('default'));
    working.transact(() => {
      for (const { parent, index } of [...targets].sort(
        (left, right) => right.index - left.index,
      )) {
        parent.delete(index, 1);
        parent.insert(
          index,
          sourceChildren.map((child) => child.clone()),
        );
      }
    }, 'unsync-synced-block');
    return {
      replacements: targets.length,
      update: Y.encodeStateAsUpdate(working, Y.encodeStateVector(target)),
    };
  } finally {
    working.destroy();
    source.destroy();
  }
}

function syncedBlockPlaceholderUpdate(
  target: Y.Doc,
  blockId: string,
  operationId: string,
  direction: 'delete' | 'restore',
): { replacements: number; remaining: number; update: Uint8Array } {
  const working = new Y.Doc();
  try {
    Y.applyUpdate(working, Y.encodeStateAsUpdate(target), 'synced-block-placeholder-working-copy');
    const sourceName = direction === 'delete' ? 'syncedBlock' : 'deletedSyncedBlock';
    const targetName = direction === 'delete' ? 'deletedSyncedBlock' : 'syncedBlock';
    const targets: Array<{ index: number; parent: Y.XmlElement | Y.XmlFragment }> = [];
    const visit = (parent: Y.XmlElement | Y.XmlFragment) => {
      parent.toArray().forEach((child, index) => {
        if (!(child instanceof Y.XmlElement)) return;
        if (
          child.nodeName === sourceName &&
          child.getAttribute('syncedBlockId') === blockId &&
          (direction === 'delete' || child.getAttribute('deletionOperationId') === operationId)
        ) {
          targets.push({ index, parent });
          return;
        }
        visit(child);
      });
    };
    visit(working.getXmlFragment('default'));
    working.transact(() => {
      for (const { parent, index } of [...targets].sort(
        (left, right) => right.index - left.index,
      )) {
        const replacement = new Y.XmlElement(targetName);
        replacement.setAttribute('syncedBlockId', blockId);
        if (direction === 'delete') {
          replacement.setAttribute('deletionOperationId', operationId);
        }
        parent.delete(index, 1);
        parent.insert(index, [replacement]);
      }
    }, `synced-block-${direction}`);
    return {
      replacements: targets.length,
      remaining:
        direction === 'delete'
          ? documentSyncedBlockIds(working).filter((id) => id === blockId).length
          : documentDeletedSyncedBlockCount(working, blockId, operationId),
      update: Y.encodeStateAsUpdate(working, Y.encodeStateVector(target)),
    };
  } finally {
    working.destroy();
  }
}

export function syncedBlockDeleteUpdate(
  target: Y.Doc,
  blockId: string,
  operationId: string,
): { replacements: number; remaining: number; update: Uint8Array } {
  return syncedBlockPlaceholderUpdate(target, blockId, operationId, 'delete');
}

export function syncedBlockRestoreUpdate(
  target: Y.Doc,
  blockId: string,
  operationId: string,
): { replacements: number; remaining: number; update: Uint8Array } {
  return syncedBlockPlaceholderUpdate(target, blockId, operationId, 'restore');
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
  private readonly httpAwarenessSeenAt = new Map<number, number>();
  private readonly sockets = new Set<WebSocket>();
  private readonly attachments = new WeakMap<WebSocket, SocketAttachment>();
  private readonly wsChunks = new WeakMap<WebSocket, ChunkAssembler>();
  private readonly httpChunks = createChunkAssembler();
  private messageQueue: Promise<void> = Promise.resolve();
  private maintenanceQueue: Promise<void> = Promise.resolve();
  private httpSyncBusy = false;

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
    try {
      const snapshots = (await this.state.storage.sql
        .exec('SELECT seq, state_blob FROM snapshots ORDER BY seq DESC LIMIT 1')
        .toArray()) as unknown as SnapshotRow[];
      const snapshot = snapshots[0];
      if (snapshot) {
        try {
          Y.applyUpdate(this.document, decodeStoredBytes(snapshot.state_blob), 'restore');
          this.currentSeq = Number(snapshot.seq);
        } catch (reason) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'document_snapshot_restore_failed',
              message: reason instanceof Error ? reason.message : String(reason),
            }),
          );
          this.currentSeq = 0;
        }
      }

      const updates = (await this.state.storage.sql
        .exec(
          'SELECT seq, update_blob FROM updates WHERE seq > ? ORDER BY seq ASC',
          this.currentSeq,
        )
        .toArray()) as unknown as UpdateRow[];
      for (const update of updates) {
        try {
          Y.applyUpdate(this.document, decodeStoredBytes(update.update_blob), 'restore');
          this.currentSeq = Number(update.seq);
        } catch (reason) {
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'document_update_restore_failed',
              seq: update.seq,
              message: reason instanceof Error ? reason.message : String(reason),
            }),
          );
        }
      }
    } catch (reason) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'document_restore_failed',
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
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
      if (message === HTTP_SYNC_FIELD_TOO_LARGE) {
        return new Response('Sync payload too large', { status: 413 });
      }
      return new Response(`rdocs_do_error:${message}`.slice(0, 500), { status: 500 });
    }
  }

  private async handleFetch(request: Request): Promise<Response> {
    await this.ready;
    const url = new URL(request.url);

    if (url.pathname === '/internal/access' && request.method === 'POST') {
      const body = (await request.json()) as {
        enabled?: boolean;
        closeConnections?: boolean;
      };
      this.editingEnabled = body.enabled === true;
      if (!this.editingEnabled || body.closeConnections === true) {
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

    if (url.pathname === '/internal/export-snapshot' && request.method === 'POST') {
      const snapshot = await this.createSnapshot('manual', request.headers.get('x-rdocs-actor-id'));
      if (snapshot.state.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
        return new Response('Revision snapshot too large', { status: 413 });
      }
      return new Response(toArrayBuffer(snapshot.state), {
        headers: {
          'content-type': 'application/octet-stream',
          'cache-control': 'no-store',
          'x-rdocs-snapshot-id': snapshot.id,
          'x-rdocs-snapshot-seq': String(snapshot.seq),
          'x-rdocs-content-hash': snapshot.contentHash,
        },
      });
    }

    if (url.pathname === '/internal/initialize-generation' && request.method === 'POST') {
      return this.initializeGeneration(request);
    }

    if (url.pathname === '/internal/rebase' && request.method === 'POST') {
      this.editingEnabled = false;
      for (const socket of this.sockets) {
        try {
          socket.close(4410, 'document_rebased');
        } catch {
          // Socket already closed.
        }
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === '/internal/http-sync' && request.method === 'POST') {
      if (this.httpSyncBusy) {
        return new Response('Collaboration room busy', {
          status: 503,
          headers: { 'retry-after': '1' },
        });
      }
      this.httpSyncBusy = true;
      const syncTask = this.messageQueue
        .then(() => this.handleHttpSync(request))
        .finally(() => {
          this.httpSyncBusy = false;
        });
      this.messageQueue = syncTask.then(
        () => undefined,
        () => undefined,
      );
      return syncTask;
    }

    if (url.pathname === '/internal/unsync-synced-block' && request.method === 'POST') {
      const task = this.messageQueue.then(() => this.unsyncSyncedBlock(request));
      this.messageQueue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    }

    if (url.pathname === '/internal/delete-synced-block' && request.method === 'POST') {
      const task = this.messageQueue.then(() =>
        this.mutateSyncedBlockPlaceholder(request, 'delete'),
      );
      this.messageQueue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    }

    if (url.pathname === '/internal/restore-synced-block' && request.method === 'POST') {
      const task = this.messageQueue.then(() =>
        this.mutateSyncedBlockPlaceholder(request, 'restore'),
      );
      this.messageQueue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    }

    if (url.pathname === '/internal/contains-synced-block' && request.method === 'POST') {
      const blockId = request.headers.get('x-rdocs-synced-block-id') ?? '';
      const task = this.messageQueue.then(() =>
        Response.json({ contains: documentSyncedBlockIds(this.document).includes(blockId) }),
      );
      this.messageQueue = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    }

    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('WebSocket upgrade required', { status: 426 });
    }

    if (request.headers.get('x-rdocs-editing-enabled') !== '1') {
      return new Response('Collaboration is disabled', { status: 403 });
    }
    if (this.sockets.size >= MAX_COLLABORATORS) {
      return new Response('Document collaborator limit reached', { status: 429 });
    }
    this.editingEnabled = true;

    const attachment: SocketAttachment = {
      actorId: request.headers.get('x-rdocs-actor-id') ?? 'unknown',
      displayName: request.headers.get('x-rdocs-display-name') ?? 'Unknown',
      role: collaborationRoleCanEdit(request.headers.get('x-rdocs-role')) ? 'editor' : 'viewer',
      pageId: request.headers.get('x-rdocs-page-id') ?? '',
      generation: Number(request.headers.get('x-rdocs-generation') ?? 1),
      aclVersion: Number(request.headers.get('x-rdocs-acl-version') ?? 1),
      awarenessClientIds: [],
      lastAwarenessAt: 0,
      resourceKind:
        request.headers.get('x-rdocs-resource-kind') === 'synced_block' ? 'synced_block' : 'page',
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

    this.sendSocket(server, syncMessage(SYNC_STEP_1, Y.encodeStateVector(this.document)));
    const currentClients = [...this.awareness.getStates().keys()];
    if (currentClients.length > 0) {
      this.sendSocket(
        server,
        awarenessMessage(encodeAwarenessUpdate(this.awareness, currentClients)),
      );
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHttpSync(request: Request): Promise<Response> {
    if (request.headers.get('x-rdocs-editing-enabled') !== '1' || !this.editingEnabled) {
      return new Response('Collaboration is disabled', { status: 403 });
    }

    const assembled = await this.readHttpSyncBody(request);
    if (assembled instanceof Response) return assembled;
    const body = assembled;
    if (body.byteLength > MAX_HTTP_SYNC_BODY_BYTES) {
      return new Response('Sync request too large', { status: 413 });
    }
    let decodedRequest: ReturnType<typeof decodeHttpSyncRequest>;
    try {
      decodedRequest = decodeHttpSyncRequest(body);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '';
      if (message === HTTP_SYNC_FIELD_TOO_LARGE) {
        return new Response('Sync request too large', { status: 413 });
      }
      return new Response('Invalid sync request', { status: 400 });
    }
    const { clientStateVector, clientUpdate, awarenessUpdate } = decodedRequest;
    if (clientUpdate.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      return new Response('Sync request too large', { status: 413 });
    }
    const role = collaborationRoleCanEdit(request.headers.get('x-rdocs-role'))
      ? 'editor'
      : 'viewer';
    const actorId = request.headers.get('x-rdocs-actor-id') ?? 'unknown';

    let hasDocumentChanges = false;
    let awarenessIds: number[] = [];
    try {
      hasDocumentChanges = yjsUpdateChangesDocument(this.document, clientUpdate);
      if (awarenessUpdate.byteLength > 0) awarenessIds = awarenessClientIds(awarenessUpdate);
    } catch {
      return new Response('Invalid sync payload', { status: 400 });
    }

    if (hasDocumentChanges) {
      if (role !== 'editor') return new Response('Editing is disabled', { status: 403 });
      const pageId = request.headers.get('x-rdocs-page-id') ?? '';
      const generation = Number(request.headers.get('x-rdocs-generation'));
      const resourceKind =
        request.headers.get('x-rdocs-resource-kind') === 'synced_block' ? 'synced_block' : 'page';
      try {
        await this.commitDocumentUpdate(clientUpdate, actorId, 'http-sync', {
          pageId,
          generation,
          resourceKind,
        });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : String(reason);
        if (message === HTTP_SYNC_FIELD_TOO_LARGE) {
          return new Response('Sync request too large', { status: 413 });
        }
        console.error(
          JSON.stringify({
            level: 'error',
            event: 'http_sync_persist_failed',
            message,
          }),
        );
        return new Response('Failed to persist sync', { status: 503 });
      }
    }

    if (awarenessUpdate.byteLength > 0) {
      const knownClients = this.awareness.getStates();
      const newClientCount = awarenessIds.filter((clientId) => !knownClients.has(clientId)).length;
      if (knownClients.size + newClientCount > MAX_COLLABORATORS) {
        return new Response('Document collaborator limit reached', { status: 429 });
      }
      applyAwarenessUpdate(this.awareness, awarenessUpdate, 'http-sync');
      const now = Date.now();
      for (const clientId of awarenessIds) this.httpAwarenessSeenAt.set(clientId, now);
    }

    const awarenessCutoff = Date.now() - HTTP_AWARENESS_TIMEOUT_MS;
    const socketAwarenessIds = new Set<number>();
    for (const socket of this.sockets) {
      for (const clientId of this.attachments.get(socket)?.awarenessClientIds ?? []) {
        socketAwarenessIds.add(clientId);
      }
    }
    const expiredAwarenessIds: number[] = [];
    for (const [clientId, seenAt] of this.httpAwarenessSeenAt) {
      if (seenAt >= awarenessCutoff) continue;
      if (socketAwarenessIds.has(clientId)) {
        this.httpAwarenessSeenAt.delete(clientId);
        continue;
      }
      expiredAwarenessIds.push(clientId);
      this.httpAwarenessSeenAt.delete(clientId);
    }
    if (expiredAwarenessIds.length > 0) {
      removeAwarenessStates(this.awareness, expiredAwarenessIds, 'http-timeout');
    }

    const currentClients = [...this.awareness.getStates().keys()];
    let response: Uint8Array;
    try {
      response = encodeHttpSyncResponse({
        serverUpdate: Y.encodeStateAsUpdate(this.document, clientStateVector),
        serverStateVector: Y.encodeStateVector(this.document),
        awarenessUpdate:
          currentClients.length > 0
            ? encodeAwarenessUpdate(this.awareness, currentClients)
            : new Uint8Array(),
      });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '';
      if (message === HTTP_SYNC_FIELD_TOO_LARGE) {
        return new Response('Sync payload too large', { status: 413 });
      }
      throw reason;
    }
    return new Response(toArrayBuffer(response), {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-rdocs-sync-seq': String(this.currentSeq),
      },
    });
  }

  private async readHttpSyncBody(request: Request): Promise<Uint8Array | Response> {
    const raw = new Uint8Array(await request.arrayBuffer());
    const protocol = request.headers.get(HTTP_SYNC_PROTOCOL_HEADER);
    if (protocol !== HTTP_SYNC_CHUNK_PROTOCOL) {
      if (raw.byteLength > MAX_UNCHUNKED_HTTP_SYNC_BYTES) {
        return new Response('Sync request too large', { status: 413 });
      }
      return raw;
    }
    if (raw.byteLength > MAX_COLLAB_CHUNK_BYTES) {
      return new Response('Sync chunk too large', { status: 413 });
    }
    const id = request.headers.get(HTTP_SYNC_CHUNK_ID_HEADER) ?? '';
    const index = Number(request.headers.get(HTTP_SYNC_CHUNK_INDEX_HEADER));
    const count = Number(request.headers.get(HTTP_SYNC_CHUNK_COUNT_HEADER));
    if (!id || !Number.isInteger(index) || !Number.isInteger(count)) {
      return new Response('Invalid sync chunk', { status: 400 });
    }
    const result = this.httpChunks.push(id, index, count, raw);
    if (result.status === 'error') {
      const status =
        result.error === 'assembled_too_large' || result.error === 'chunk_too_large' ? 413 : 400;
      return new Response(result.error, { status });
    }
    if (result.status === 'pending') {
      return new Response(null, {
        status: 202,
        headers: {
          'x-rdocs-chunk-received': String(result.received),
          'x-rdocs-chunk-count': String(result.count),
        },
      });
    }
    return result.payload;
  }

  private async unsyncSyncedBlock(request: Request): Promise<Response> {
    const blockId = request.headers.get('x-rdocs-synced-block-id') ?? '';
    const pageId = request.headers.get('x-rdocs-page-id') ?? '';
    const generation = Number(request.headers.get('x-rdocs-generation'));
    const actorId = request.headers.get('x-rdocs-actor-id') ?? '';
    if (!blockId || !pageId || !actorId || !Number.isSafeInteger(generation) || generation < 1) {
      return new Response('Invalid unsync request', { status: 400 });
    }
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_REVISION_SNAPSHOT_BYTES) {
      return new Response('Synced block snapshot too large', { status: 413 });
    }
    const snapshot = new Uint8Array(await request.arrayBuffer());
    if (!snapshot.byteLength || snapshot.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
      return new Response('Invalid synced block snapshot', { status: 400 });
    }
    let result: ReturnType<typeof syncedBlockUnsyncUpdate>;
    try {
      result = syncedBlockUnsyncUpdate(this.document, blockId, snapshot);
    } catch {
      return new Response('Invalid synced block content', { status: 400 });
    }
    if (!result.replacements || !yjsUpdateChangesDocument(this.document, result.update)) {
      await this.maybeUpdateSyncedBlockReferences(pageId, true);
      await this.maybeUpdatePageLinks(pageId, true);
      return Response.json({ ok: true, replacements: 0 });
    }
    await this.beforeDocumentChange(pageId, generation, actorId);
    await this.persistUpdate(result.update, actorId);
    Y.applyUpdate(this.document, result.update, 'unsync-synced-block');
    this.broadcast(syncMessage(SYNC_UPDATE, result.update));
    await this.maybeCreateSnapshot();
    await this.afterDocumentChange(pageId, generation, actorId);
    await this.maybeUpdateSearchProjection(pageId, generation);
    await this.maybeUpdateSyncedBlockReferences(pageId, true);
    await this.maybeUpdatePageLinks(pageId, true);
    return Response.json({ ok: true, replacements: result.replacements });
  }

  private async mutateSyncedBlockPlaceholder(
    request: Request,
    direction: 'delete' | 'restore',
  ): Promise<Response> {
    const blockId = request.headers.get('x-rdocs-synced-block-id') ?? '';
    const operationId = request.headers.get('x-rdocs-deletion-operation-id') ?? '';
    const pageId = request.headers.get('x-rdocs-page-id') ?? '';
    const generation = Number(request.headers.get('x-rdocs-generation'));
    const actorId = request.headers.get('x-rdocs-actor-id') ?? '';
    if (
      !blockId ||
      !operationId ||
      !pageId ||
      !actorId ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    ) {
      return new Response('Invalid synced block placeholder request', { status: 400 });
    }
    const result =
      direction === 'delete'
        ? syncedBlockDeleteUpdate(this.document, blockId, operationId)
        : syncedBlockRestoreUpdate(this.document, blockId, operationId);
    if (!result.replacements || !yjsUpdateChangesDocument(this.document, result.update)) {
      await this.maybeUpdateSyncedBlockReferences(pageId, true);
      await this.maybeUpdatePageLinks(pageId, true);
      return Response.json({
        ok: true,
        replacements: 0,
        remaining: result.remaining,
      });
    }
    await this.beforeDocumentChange(pageId, generation, actorId);
    await this.persistUpdate(result.update, actorId);
    Y.applyUpdate(this.document, result.update, `synced-block-${direction}`);
    this.broadcast(syncMessage(SYNC_UPDATE, result.update));
    await this.maybeCreateSnapshot();
    await this.afterDocumentChange(pageId, generation, actorId);
    await this.maybeUpdateSearchProjection(pageId, generation);
    await this.maybeUpdateSyncedBlockReferences(pageId, true);
    await this.maybeUpdatePageLinks(pageId, true);
    return Response.json({
      ok: true,
      replacements: result.replacements,
      remaining: result.remaining,
    });
  }

  async webSocketMessage(socket: WebSocket, rawMessage: unknown): Promise<void> {
    await this.ready;
    const incoming = await normalizeBinaryMessage(rawMessage);
    if (!incoming) return;
    const assembled = this.assembleWebSocketFrame(socket, incoming);
    if (assembled === 'pending') return;
    if (assembled === 'invalid') {
      socket.close(4400, 'invalid_chunk');
      return;
    }
    if (assembled.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      socket.close(4409, 'frame_too_large');
      return;
    }
    const message = assembled;

    try {
      const decoder = decoding.createDecoder(message);
      const messageType = decoding.readVarUint(decoder);
      if (messageType === MESSAGE_SYNC) {
        await this.handleSyncMessage(socket, decoder);
      } else if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder);
        const attachment = this.attachments.get(socket);
        const now = Date.now();
        if (attachment && now - attachment.lastAwarenessAt < MIN_AWARENESS_INTERVAL_MS) return;
        if (attachment) attachment.lastAwarenessAt = now;
        const clientIds = awarenessClientIds(update);
        const knownClients = this.awareness.getStates();
        const newClientCount = clientIds.filter((clientId) => !knownClients.has(clientId)).length;
        if (knownClients.size + newClientCount > MAX_COLLABORATORS) {
          socket.close(4429, 'collaborator_limit_reached');
          return;
        }
        this.rememberAwarenessClients(socket, clientIds);
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

  private assembleWebSocketFrame(
    socket: WebSocket,
    incoming: Uint8Array,
  ): Uint8Array | 'pending' | 'invalid' {
    const inspected = inspectWsFrame(incoming);
    if (inspected.kind === 'plain') return incoming;
    if (inspected.kind === 'invalid') return 'invalid';
    if (incoming.byteLength > MAX_COLLAB_CHUNK_BYTES + 32) return 'invalid';
    let assembler = this.wsChunks.get(socket);
    if (!assembler) {
      assembler = createChunkAssembler();
      this.wsChunks.set(socket, assembler);
    }
    const result = assembler.push(
      inspected.id,
      inspected.index,
      inspected.count,
      inspected.payload,
    );
    if (result.status === 'error') return 'invalid';
    if (result.status === 'pending') return 'pending';
    return result.payload;
  }

  private async handleSyncMessage(socket: WebSocket, decoder: decoding.Decoder): Promise<void> {
    const subtype = decoding.readVarUint(decoder);
    if (subtype === SYNC_STEP_1) {
      const stateVector = decoding.readVarUint8Array(decoder);
      this.sendSocket(
        socket,
        syncMessage(SYNC_STEP_2, Y.encodeStateAsUpdate(this.document, stateVector)),
      );
      return;
    }

    if (subtype !== SYNC_STEP_2 && subtype !== SYNC_UPDATE) return;
    const attachment = this.attachments.get(socket);
    if (!this.editingEnabled || attachment?.role !== 'editor') {
      socket.close(4403, 'permission_changed');
      return;
    }

    const update = decoding.readVarUint8Array(decoder);
    if (update.byteLength > MAX_COLLAB_UPDATE_BYTES) {
      socket.close(4409, 'update_too_large');
      return;
    }
    await this.commitDocumentUpdate(update, attachment.actorId, socket, {
      pageId: attachment.pageId,
      generation: attachment.generation,
      resourceKind: attachment.resourceKind,
    });
  }

  private enqueueMaintenance(task: () => Promise<void>): void {
    this.maintenanceQueue = this.maintenanceQueue.then(task, task);
    this.state.waitUntil(this.maintenanceQueue);
  }

  private async commitDocumentUpdate(
    update: Uint8Array,
    actorId: string,
    origin: unknown,
    pageMeta: {
      pageId: string;
      generation: number;
      resourceKind: 'page' | 'synced_block';
    },
  ): Promise<boolean> {
    if (!yjsUpdateChangesDocument(this.document, update)) return false;
    await this.persistUpdate(update, actorId);
    Y.applyUpdate(this.document, update, origin);
    this.broadcast(
      syncMessage(SYNC_UPDATE, update),
      origin instanceof WebSocket ? origin : undefined,
    );
    this.enqueueMaintenance(async () => {
      if (pageMeta.resourceKind === 'page') {
        await this.beforeDocumentChange(pageMeta.pageId, pageMeta.generation, actorId);
        await this.enforceSyncedBlockDeletionFences(pageMeta.pageId, actorId);
        await this.afterDocumentChange(pageMeta.pageId, pageMeta.generation, actorId);
        await this.maybeUpdateSearchProjection(pageMeta.pageId, pageMeta.generation);
        await this.maybeUpdateSyncedBlockReferences(pageMeta.pageId);
        await this.maybeUpdatePageLinks(pageMeta.pageId);
      } else {
        await this.recordSyncedBlockChange(pageMeta.pageId, pageMeta.generation, actorId);
      }
      await this.maybeCreateSnapshot();
    });
    return true;
  }

  private async persistUpdate(update: Uint8Array, actorId: string): Promise<void> {
    const nextSeq = this.currentSeq + 1;
    await this.state.storage.sql.exec(
      `INSERT INTO updates(seq, event_id, actor_id, update_blob, byte_size, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      nextSeq,
      crypto.randomUUID(),
      actorId,
      encodeStoredBytes(update),
      update.byteLength,
      Date.now(),
    );
    this.currentSeq = nextSeq;
    this.updatesSinceSnapshot += 1;
    this.bytesSinceSnapshot += update.byteLength;
  }

  private async recordSyncedBlockChange(
    blockId: string,
    generation: number,
    actorId: string,
  ): Promise<void> {
    if (!blockId || !Number.isSafeInteger(generation) || generation < 1) return;
    const now = Date.now();
    await Promise.all([
      this.setRoomMetaNumber('last_edit_at', now),
      this.env.DB.prepare(
        `UPDATE synced_blocks SET updated_by = ?, updated_at = ?
          WHERE id = ? AND current_generation = ? AND deleted_at IS NULL`,
      )
        .bind(actorId, now, blockId, generation)
        .run(),
    ]);
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

  private async roomMetaNumber(key: string): Promise<number | null> {
    const rows = (await this.state.storage.sql
      .exec('SELECT value FROM room_meta WHERE key = ?', key)
      .toArray()) as unknown as RoomMetaRow[];
    const value = Number(rows[0]?.value);
    return Number.isFinite(value) ? value : null;
  }

  private async setRoomMetaNumber(key: string, value: number): Promise<void> {
    await this.state.storage.sql.exec(
      `INSERT INTO room_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      String(value),
    );
  }

  private async roomMetaValue(key: string): Promise<string | null> {
    const rows = (await this.state.storage.sql
      .exec('SELECT value FROM room_meta WHERE key = ?', key)
      .toArray()) as unknown as RoomMetaRow[];
    return rows[0]?.value ?? null;
  }

  private async setRoomMetaValue(key: string, value: string): Promise<void> {
    await this.state.storage.sql.exec(
      `INSERT INTO room_meta(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }

  private async maybeUpdateSyncedBlockReferences(pageId: string, force = false): Promise<void> {
    if (!pageId) return;
    const ids = documentSyncedBlockResourceIds(this.document);
    const signature = ids.join(',');
    if (!force && (await this.roomMetaValue('synced_block_reference_ids')) === signature) return;
    const page = await this.env.DB.prepare(
      'SELECT organization_id FROM pages WHERE id = ? AND deleted_at IS NULL',
    )
      .bind(pageId)
      .first<{ organization_id: string }>();
    if (!page) return;
    const now = Date.now();
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare('DELETE FROM synced_block_references WHERE page_id = ?').bind(pageId),
      ...ids.map((blockId) =>
        this.env.DB.prepare(
          `INSERT INTO synced_block_references(
             synced_block_id, page_id, first_seen_at, last_seen_at
           )
           SELECT b.id, ?, ?, ? FROM synced_blocks b
            WHERE b.id = ? AND b.organization_id = ?
              AND (
                (b.deleted_at IS NULL AND b.lifecycle_state IN ('active', 'unsyncing'))
                OR (b.deleted_at IS NOT NULL AND b.deletion_operation_id IS NOT NULL)
              )
           ON CONFLICT(synced_block_id, page_id)
           DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        ).bind(pageId, now, now, blockId, page.organization_id),
      ),
    ];
    await this.env.DB.batch(statements);
    await this.setRoomMetaValue('synced_block_reference_ids', signature);
  }

  private async enforceSyncedBlockDeletionFences(pageId: string, actorId: string): Promise<void> {
    const blockIds = documentSyncedBlockIds(this.document);
    if (!pageId || blockIds.length === 0) return;
    const fenced: Array<{ deletion_operation_id: string; id: string }> = [];
    for (let start = 0; start < blockIds.length; start += 50) {
      const chunk = blockIds.slice(start, start + 50);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = await this.env.DB.prepare(
        `SELECT id, deletion_operation_id
           FROM synced_blocks
          WHERE id IN (${placeholders})
            AND deletion_operation_id IS NOT NULL
            AND deletion_restore_lease_at IS NULL`,
      )
        .bind(...chunk)
        .all<{ deletion_operation_id: string; id: string }>();
      fenced.push(...rows.results);
    }
    let replacements = 0;
    for (const row of fenced) {
      const result = syncedBlockDeleteUpdate(this.document, row.id, row.deletion_operation_id);
      if (!result.replacements || !yjsUpdateChangesDocument(this.document, result.update)) continue;
      await this.persistUpdate(result.update, actorId);
      Y.applyUpdate(this.document, result.update, 'synced-block-deletion-fence');
      this.broadcast(syncMessage(SYNC_UPDATE, result.update));
      replacements += result.replacements;
    }
    if (replacements > 0) {
      console.info(
        JSON.stringify({
          level: 'info',
          event: 'synced_block_deletion_fence_applied',
          pageId,
          replacements,
        }),
      );
    }
  }

  private async maybeUpdatePageLinks(pageId: string, force = false): Promise<void> {
    if (!pageId) return;
    const ids = documentPageLinkIds(this.document).filter((id) => id !== pageId);
    const signature = ids.join(',');
    if (!force && (await this.roomMetaValue('page_link_ids')) === signature) return;
    const page = await this.env.DB.prepare(
      'SELECT organization_id FROM pages WHERE id = ? AND deleted_at IS NULL',
    )
      .bind(pageId)
      .first<{ organization_id: string }>();
    if (!page) return;
    const now = Date.now();
    await this.env.DB.batch([
      this.env.DB.prepare('DELETE FROM page_links WHERE source_page_id = ?').bind(pageId),
      ...ids.map((targetPageId) =>
        this.env.DB.prepare(
          `INSERT INTO page_links(source_page_id, target_page_id, first_seen_at, last_seen_at)
           SELECT ?, target.id, ?, ? FROM pages target
            WHERE target.id = ? AND target.organization_id = ?
           ON CONFLICT(source_page_id, target_page_id)
           DO UPDATE SET last_seen_at = excluded.last_seen_at`,
        ).bind(pageId, now, now, targetPageId, page.organization_id),
      ),
    ]);
    await this.setRoomMetaValue('page_link_ids', signature);
  }

  private async automaticRevisionDue(now: number): Promise<{
    lastEditAt: number | null;
    lastRevisionAt: number | null;
    mayAttempt: boolean;
  }> {
    const [lastEditAt, lastRevisionAt, lastAttemptAt] = await Promise.all([
      this.roomMetaNumber('last_edit_at'),
      this.roomMetaNumber('last_automatic_revision_at'),
      this.roomMetaNumber('last_automatic_revision_attempt_at'),
    ]);
    return {
      lastEditAt,
      lastRevisionAt,
      mayAttempt: lastAttemptAt === null || now - lastAttemptAt >= AUTOMATIC_REVISION_RETRY_MS,
    };
  }

  private async beforeDocumentChange(
    pageId: string,
    generation: number,
    actorId: string,
  ): Promise<void> {
    if (!pageId || !Number.isSafeInteger(generation) || generation < 1) return;
    const now = Date.now();
    const state = await this.automaticRevisionDue(now);
    if (state.lastEditAt === null || state.lastRevisionAt === null) {
      await Promise.all([
        this.setRoomMetaNumber('last_edit_at', now),
        this.setRoomMetaNumber('last_automatic_revision_at', now),
      ]);
      return;
    }
    if (
      state.mayAttempt &&
      this.currentSeq > 0 &&
      now - state.lastEditAt >= EDITING_SESSION_IDLE_MS &&
      state.lastEditAt > state.lastRevisionAt
    ) {
      await this.tryCreateAutomaticRevision(
        pageId,
        generation,
        actorId,
        '编辑会话结束自动保存',
        now,
      );
    }
  }

  private async afterDocumentChange(
    pageId: string,
    generation: number,
    actorId: string,
  ): Promise<void> {
    if (!pageId || !Number.isSafeInteger(generation) || generation < 1) return;
    const now = Date.now();
    await this.setRoomMetaNumber('last_edit_at', now);
    const state = await this.automaticRevisionDue(now);
    if (
      state.mayAttempt &&
      state.lastRevisionAt !== null &&
      now - state.lastRevisionAt >= AUTOMATIC_REVISION_INTERVAL_MS
    ) {
      await this.tryCreateAutomaticRevision(pageId, generation, actorId, '持续编辑自动保存', now);
    }
    await this.maybeRecordPageUpdate(pageId, generation, actorId, now).catch((reason) =>
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'page_update_event_failed',
          pageId,
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      ),
    );
  }

  private async maybeRecordPageUpdate(
    pageId: string,
    generation: number,
    actorId: string,
    now: number,
  ): Promise<void> {
    const lastRecordedAt = await this.roomMetaNumber('last_page_update_event_at');
    if (lastRecordedAt !== null && now - lastRecordedAt < 60_000) return;
    const page = await this.env.DB.prepare(
      `SELECT organization_id, current_generation FROM pages
        WHERE id = ? AND deleted_at IS NULL`,
    )
      .bind(pageId)
      .first<RevisionPageRow>();
    if (!page || Number(page.current_generation) !== generation) return;
    const eventId = crypto.randomUUID();
    await this.env.DB.prepare(
      `INSERT INTO audit_events(
         id, organization_id, actor_id, event_type, target_type, target_id,
         request_id, metadata_json, created_at
       ) VALUES (?, ?, ?, 'page.content_updated', 'page', ?, NULL, ?, ?)`,
    )
      .bind(
        eventId,
        page.organization_id,
        actorId,
        pageId,
        JSON.stringify({ generation, collabSeq: this.currentSeq }),
        now,
      )
      .run();
    this.state.waitUntil(
      deliverPageUpdateNotifications(this.env, {
        organizationId: page.organization_id,
        pageId,
        actorId,
        eventKey: `page-content:${pageId}:${generation}:${this.currentSeq}`,
        metadata: { eventType: 'page.content_updated', generation, collabSeq: this.currentSeq },
      })
        .then(() => undefined)
        .catch((reason) =>
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'page_update_notification_failed',
              pageId,
              message: reason instanceof Error ? reason.message : String(reason),
            }),
          ),
        ),
    );
    await this.setRoomMetaNumber('last_page_update_event_at', now);
  }

  private async tryCreateAutomaticRevision(
    pageId: string,
    generation: number,
    actorId: string,
    description: string,
    now: number,
  ): Promise<void> {
    await this.setRoomMetaNumber('last_automatic_revision_attempt_at', now);
    try {
      const page = await this.env.DB.prepare(
        `SELECT organization_id, current_generation FROM pages
          WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(pageId)
        .first<RevisionPageRow>();
      if (!page || Number(page.current_generation) !== generation) return;
      const revisionId = crypto.randomUUID();
      const snapshot = await this.createSnapshot('automatic', actorId);
      const snapshotRef = `organizations/${page.organization_id}/pages/${pageId}/revisions/${revisionId}.yjs`;
      await this.env.ATTACHMENTS.put(snapshotRef, toArrayBuffer(snapshot.state), {
        httpMetadata: { contentType: 'application/octet-stream' },
        customMetadata: {
          pageId,
          generation: String(generation),
          collabSeq: String(snapshot.seq),
          contentHash: snapshot.contentHash,
        },
      });
      try {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO revisions(
               id, organization_id, page_id, generation, collab_seq, kind,
               label, description, snapshot_location, snapshot_ref, content_hash,
               created_by, created_at
             ) VALUES (?, ?, ?, ?, ?, 'automatic', NULL, ?, 'r2', ?, ?, ?, ?)`,
          ).bind(
            revisionId,
            page.organization_id,
            pageId,
            generation,
            snapshot.seq,
            description,
            snapshotRef,
            snapshot.contentHash,
            actorId,
            now,
          ),
          this.env.DB.prepare(
            `INSERT INTO audit_events(
               id, organization_id, actor_id, event_type, target_type, target_id,
               request_id, metadata_json, created_at
             ) VALUES (?, ?, ?, 'revision.created', 'page', ?, NULL, ?, ?)`,
          ).bind(
            crypto.randomUUID(),
            page.organization_id,
            actorId,
            pageId,
            JSON.stringify({ revisionId, kind: 'automatic', generation }),
            now,
          ),
        ]);
      } catch (reason) {
        await this.env.ATTACHMENTS.delete(snapshotRef).catch(() => undefined);
        throw reason;
      }
      await this.setRoomMetaNumber('last_automatic_revision_at', now);
    } catch (reason) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'automatic_revision_failed',
          pageId,
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  private async maybeUpdateSearchProjection(pageId: string, generation: number): Promise<void> {
    if (!pageId || !Number.isSafeInteger(generation) || generation < 1) return;
    const now = Date.now();
    const lastProjectionAt = await this.roomMetaNumber('last_search_projection_at');
    if (lastProjectionAt !== null && now - lastProjectionAt < SEARCH_PROJECTION_INTERVAL_MS) return;
    await this.setRoomMetaNumber('last_search_projection_at', now);
    this.state.waitUntil(this.updateSearchProjection(pageId, generation, now));
  }

  private async updateSearchProjection(
    pageId: string,
    generation: number,
    updatedAt: number,
  ): Promise<void> {
    try {
      const page = await this.env.DB.prepare(
        `SELECT organization_id, space_id, title, current_generation
           FROM pages WHERE id = ? AND deleted_at IS NULL`,
      )
        .bind(pageId)
        .first<SearchPageRow>();
      if (!page || Number(page.current_generation) !== generation) return;
      const body = normalizeSearchText(documentPlainText(this.document)).slice(0, 500_000);
      const indexedText = searchIndexText(`${page.title}\n${body}`).slice(0, 750_000);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO page_search_projection(
             page_id, organization_id, space_id, generation, collab_seq,
             title, normalized_body, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(page_id) DO UPDATE SET
             organization_id = excluded.organization_id,
             space_id = excluded.space_id,
             generation = excluded.generation,
             collab_seq = excluded.collab_seq,
             title = excluded.title,
             normalized_body = excluded.normalized_body,
             updated_at = excluded.updated_at`,
        ).bind(
          pageId,
          page.organization_id,
          page.space_id,
          generation,
          this.currentSeq,
          page.title,
          body,
          updatedAt,
        ),
        this.env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(pageId),
        this.env.DB.prepare(
          'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
        ).bind(pageId, searchIndexText(page.title), indexedText),
      ]);
    } catch (reason) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'search_projection_failed',
          pageId,
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
    }
  }

  private async createSnapshot(
    kind: 'automatic' | 'manual' | 'restore',
    createdBy: string | null = null,
  ): Promise<SnapshotArtifact> {
    const state = Y.encodeStateAsUpdate(this.document);
    const vector = Y.encodeStateVector(this.document);
    const id = crypto.randomUUID();
    const contentHash = await sha256Hex(state);
    await this.state.storage.sql.exec(
      `INSERT INTO snapshots(id, seq, state_blob, state_vector, kind, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.currentSeq,
      encodeStoredBytes(state),
      encodeStoredBytes(vector),
      kind,
      createdBy,
      Date.now(),
    );
    this.updatesSinceSnapshot = 0;
    this.bytesSinceSnapshot = 0;
    return { id, seq: this.currentSeq, state, stateVector: vector, contentHash };
  }

  private async initializeGeneration(request: Request): Promise<Response> {
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > MAX_REVISION_SNAPSHOT_BYTES) {
      return new Response('Revision snapshot too large', { status: 413 });
    }

    const state = new Uint8Array(await request.arrayBuffer());
    if (state.byteLength === 0 || state.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
      return new Response('Invalid revision snapshot size', { status: 400 });
    }
    const requestedHash = request.headers.get('x-rdocs-content-hash') ?? '';
    const contentHash = await sha256Hex(state);
    if (!requestedHash || requestedHash !== contentHash) {
      return new Response('Revision snapshot hash mismatch', { status: 400 });
    }

    const existingSnapshots = (await this.state.storage.sql
      .exec('SELECT id, seq, state_blob FROM snapshots ORDER BY seq DESC LIMIT 1')
      .toArray()) as unknown as SnapshotRow[];
    const existing = existingSnapshots[0];
    if (existing) {
      const existingState = decodeStoredBytes(existing.state_blob);
      if ((await sha256Hex(existingState)) !== contentHash) {
        return new Response('Generation already initialized', { status: 409 });
      }
      Y.applyUpdate(this.document, existingState, 'restore-initialize');
      return Response.json({ ok: true, idempotent: true, contentHash });
    }

    const validationDocument = new Y.Doc();
    try {
      Y.applyUpdate(validationDocument, state, 'restore-validation');
    } catch {
      return new Response('Invalid Yjs revision snapshot', { status: 400 });
    } finally {
      validationDocument.destroy();
    }

    const snapshotId = crypto.randomUUID();
    const vectorDocument = new Y.Doc();
    Y.applyUpdate(vectorDocument, state, 'restore-vector');
    const stateVector = Y.encodeStateVector(vectorDocument);
    vectorDocument.destroy();
    await this.state.storage.sql.exec(
      `INSERT INTO snapshots(id, seq, state_blob, state_vector, kind, created_by, created_at)
       VALUES (?, 0, ?, ?, 'restore', ?, ?)`,
      snapshotId,
      encodeStoredBytes(state),
      encodeStoredBytes(stateVector),
      request.headers.get('x-rdocs-actor-id'),
      Date.now(),
    );
    await this.state.storage.sql.exec(
      `INSERT OR REPLACE INTO room_meta(key, value) VALUES
       ('page_id', ?),
       ('generation', ?),
       ('restored_from_revision', ?),
       ('content_hash', ?)`,
      request.headers.get('x-rdocs-page-id') ?? '',
      request.headers.get('x-rdocs-generation') ?? '',
      request.headers.get('x-rdocs-revision-id') ?? '',
      contentHash,
    );
    Y.applyUpdate(this.document, state, 'restore-initialize');
    this.currentSeq = 0;
    this.updatesSinceSnapshot = 0;
    this.bytesSinceSnapshot = 0;
    if (request.headers.get('x-rdocs-resource-kind') !== 'synced_block') {
      await this.maybeUpdateSyncedBlockReferences(
        request.headers.get('x-rdocs-page-id') ?? '',
        true,
      );
      await this.maybeUpdatePageLinks(request.headers.get('x-rdocs-page-id') ?? '', true);
    }
    return Response.json({ ok: true, idempotent: false, contentHash });
  }

  private rememberAwarenessClients(socket: WebSocket, ids: number[]): void {
    const attachment = this.attachments.get(socket);
    if (!attachment) return;
    attachment.awarenessClientIds = [...new Set([...attachment.awarenessClientIds, ...ids])];
    this.attachments.set(socket, attachment);
  }

  private sendSocket(socket: WebSocket, message: Uint8Array): void {
    try {
      for (const frame of encodeWsChunkFrames(message)) {
        socket.send(frame);
      }
    } catch {
      // Runtime will deliver a close/error callback if the socket is stale.
    }
  }

  private broadcast(message: Uint8Array, except?: WebSocket): void {
    for (const socket of this.sockets) {
      if (socket === except) continue;
      this.sendSocket(socket, message);
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

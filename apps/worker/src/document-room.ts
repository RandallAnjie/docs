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
  decodeHttpSyncRequest,
  encodeHttpSyncResponse,
  MAX_COLLAB_FRAME_BYTES,
  MAX_HTTP_SYNC_BODY_BYTES,
  MAX_REVISION_SNAPSHOT_BYTES,
} from '@rdocs/shared';

import type { Env } from './env';
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
  state_blob: string;
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
  update_blob: string;
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
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, before);
    Y.applyUpdate(candidate, update);
    return !equalBytes(before, Y.encodeStateAsUpdate(candidate));
  } finally {
    candidate.destroy();
  }
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
      const syncTask = this.messageQueue.then(() => this.handleHttpSync(request));
      this.messageQueue = syncTask.then(
        () => undefined,
        () => undefined,
      );
      return syncTask;
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

    server.send(syncMessage(SYNC_STEP_1, Y.encodeStateVector(this.document)));
    const currentClients = [...this.awareness.getStates().keys()];
    if (currentClients.length > 0) {
      server.send(awarenessMessage(encodeAwarenessUpdate(this.awareness, currentClients)));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private async handleHttpSync(request: Request): Promise<Response> {
    if (request.headers.get('x-rdocs-editing-enabled') !== '1' || !this.editingEnabled) {
      return new Response('Collaboration is disabled', { status: 403 });
    }

    const body = new Uint8Array(await request.arrayBuffer());
    if (body.byteLength > MAX_HTTP_SYNC_BODY_BYTES) {
      return new Response('Sync request too large', { status: 413 });
    }
    let decodedRequest: ReturnType<typeof decodeHttpSyncRequest>;
    try {
      decodedRequest = decodeHttpSyncRequest(body);
    } catch {
      return new Response('Invalid sync request', { status: 400 });
    }
    const { clientStateVector, clientUpdate, awarenessUpdate } = decodedRequest;
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
      if (resourceKind === 'page') await this.beforeDocumentChange(pageId, generation, actorId);
      await this.persistUpdate(clientUpdate, actorId);
      Y.applyUpdate(this.document, clientUpdate, 'http-sync');
      this.broadcast(syncMessage(SYNC_UPDATE, clientUpdate));
      await this.maybeCreateSnapshot();
      if (resourceKind === 'page') {
        await this.afterDocumentChange(pageId, generation, actorId);
        await this.maybeUpdateSearchProjection(pageId, generation);
      } else {
        await this.recordSyncedBlockChange(pageId, generation, actorId);
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
    const response = encodeHttpSyncResponse({
      serverUpdate: Y.encodeStateAsUpdate(this.document, clientStateVector),
      serverStateVector: Y.encodeStateVector(this.document),
      awarenessUpdate:
        currentClients.length > 0
          ? encodeAwarenessUpdate(this.awareness, currentClients)
          : new Uint8Array(),
    });
    return new Response(toArrayBuffer(response), {
      headers: {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-rdocs-sync-seq': String(this.currentSeq),
      },
    });
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
    if (!yjsUpdateChangesDocument(this.document, update)) return;

    if (attachment.resourceKind === 'page') {
      await this.beforeDocumentChange(attachment.pageId, attachment.generation, attachment.actorId);
    }
    await this.persistUpdate(update, attachment.actorId);
    Y.applyUpdate(this.document, update, socket);
    this.broadcast(syncMessage(SYNC_UPDATE, update), socket);
    await this.maybeCreateSnapshot();
    if (attachment.resourceKind === 'page') {
      await this.afterDocumentChange(attachment.pageId, attachment.generation, attachment.actorId);
      await this.maybeUpdateSearchProjection(attachment.pageId, attachment.generation);
    } else {
      await this.recordSyncedBlockChange(
        attachment.pageId,
        attachment.generation,
        attachment.actorId,
      );
    }
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
      bytesToBase64(state),
      bytesToBase64(vector),
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
      const existingState = base64ToBytes(existing.state_blob);
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
      bytesToBase64(state),
      bytesToBase64(stateVector),
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
    return Response.json({ ok: true, idempotent: false, contentHash });
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

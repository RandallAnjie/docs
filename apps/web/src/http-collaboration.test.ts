import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import {
  ChunkAssembler,
  decodeHttpSyncRequest,
  encodeHttpSyncResponse,
  HTTP_SYNC_CHUNK_COUNT_HEADER,
  HTTP_SYNC_CHUNK_ID_HEADER,
  HTTP_SYNC_CHUNK_INDEX_HEADER,
  HTTP_SYNC_CHUNK_PROTOCOL,
  HTTP_SYNC_PROTOCOL_HEADER,
  type HttpSyncRequest,
} from '@rdocs/shared';

import { HttpCollaborationTransport } from './http-collaboration';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpCollaborationTransport', () => {
  it('converges local and server documents in both directions', async () => {
    const serverDocument = new Y.Doc();
    serverDocument.getText('default').insert(0, 'server');
    const clientDocument = new Y.Doc();
    const awareness = new Awareness(clientDocument);
    awareness.setLocalStateField('user', { name: 'Tester', color: '#123456' });
    const requests: HttpSyncRequest[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const request = decodeHttpSyncRequest(new Uint8Array(init.body as ArrayBuffer));
        requests.push(request);
        Y.applyUpdate(serverDocument, request.clientUpdate);
        const response = encodeHttpSyncResponse({
          serverUpdate: Y.encodeStateAsUpdate(serverDocument, request.clientStateVector),
          serverStateVector: Y.encodeStateVector(serverDocument),
          awarenessUpdate: new Uint8Array(),
        });
        return new Response(toArrayBuffer(response));
      }),
    );

    const states: string[] = [];
    const transport = new HttpCollaborationTransport({
      pageId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
      document: clientDocument,
      awareness,
      ticket: 'ticket',
      renewTicket: async () => 'renewed-ticket',
      onState: (state) => states.push(state),
      pollIntervalMs: 60_000,
    });
    await transport.start();
    expect(clientDocument.getText('default').toString()).toBe('server');

    clientDocument.getText('default').insert(6, '-client');
    await transport.flushNow();
    expect(serverDocument.getText('default').toString()).toBe('server-client');
    expect(requests).toHaveLength(2);
    expect(states).toContain('synced');

    transport.stop();
    awareness.destroy();
    clientDocument.destroy();
    serverDocument.destroy();
  });

  it('chunks a several-hundred-kilobyte paste across multiple HTTP requests', async () => {
    const serverDocument = new Y.Doc();
    const clientDocument = new Y.Doc();
    const awareness = new Awareness(clientDocument);
    const assembler = new ChunkAssembler();
    const chunkedCalls: number[] = [];

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        const headers = new Headers(init.headers);
        const raw = new Uint8Array(init.body as ArrayBuffer);
        let payload: Uint8Array = raw;
        if (headers.get(HTTP_SYNC_PROTOCOL_HEADER) === HTTP_SYNC_CHUNK_PROTOCOL) {
          chunkedCalls.push(raw.byteLength);
          const result = assembler.push(
            headers.get(HTTP_SYNC_CHUNK_ID_HEADER) ?? '',
            Number(headers.get(HTTP_SYNC_CHUNK_INDEX_HEADER)),
            Number(headers.get(HTTP_SYNC_CHUNK_COUNT_HEADER)),
            raw,
          );
          if (result.status === 'pending') return new Response(null, { status: 202 });
          if (result.status === 'error') return new Response(result.error, { status: 400 });
          payload = result.payload;
        }
        const request = decodeHttpSyncRequest(payload);
        Y.applyUpdate(serverDocument, request.clientUpdate);
        const response = encodeHttpSyncResponse({
          serverUpdate: Y.encodeStateAsUpdate(serverDocument, request.clientStateVector),
          serverStateVector: Y.encodeStateVector(serverDocument),
          awarenessUpdate: new Uint8Array(),
        });
        return new Response(toArrayBuffer(response));
      }),
    );

    const transport = new HttpCollaborationTransport({
      pageId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
      document: clientDocument,
      awareness,
      ticket: 'ticket',
      renewTicket: async () => 'renewed-ticket',
      onState: () => undefined,
      pollIntervalMs: 60_000,
    });
    await transport.start();
    clientDocument.getText('default').insert(0, 'a'.repeat(300 * 1024));
    await transport.flushNow();

    expect(serverDocument.getText('default').toString().length).toBe(300 * 1024);
    expect(chunkedCalls.length).toBeGreaterThan(1);
    expect(Math.max(...chunkedCalls)).toBeLessThanOrEqual(64 * 1024);
    transport.stop();
    awareness.destroy();
    clientDocument.destroy();
    serverDocument.destroy();
  });

  it('does not immediately retry a 413 payload', async () => {
    const emptyDocument = new Y.Doc();
    const empty = encodeHttpSyncResponse({
      serverUpdate: new Uint8Array(),
      serverStateVector: Y.encodeStateVector(emptyDocument),
      awarenessUpdate: new Uint8Array(),
    });
    emptyDocument.destroy();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(toArrayBuffer(empty)))
      .mockResolvedValue(new Response('too large', { status: 413 }));
    vi.stubGlobal('fetch', fetchMock);

    const clientDocument = new Y.Doc();
    const awareness = new Awareness(clientDocument);
    const states: string[] = [];
    const transport = new HttpCollaborationTransport({
      pageId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
      document: clientDocument,
      awareness,
      ticket: 'ticket',
      renewTicket: async () => 'ticket',
      onState: (state) => states.push(state),
      pollIntervalMs: 60_000,
    });
    await transport.start();
    clientDocument.getText('default').insert(0, 'overflow');
    await transport.flushNow();
    expect(states).toContain('disconnected');
    const calls = fetchMock.mock.calls.length;
    await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
    expect(fetchMock.mock.calls.length).toBe(calls);
    transport.stop();
    awareness.destroy();
    clientDocument.destroy();
  });

  it('reports a restored generation without retrying the old room', async () => {
    const clientDocument = new Y.Doc();
    const awareness = new Awareness(clientDocument);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(null, {
            status: 409,
            headers: { 'x-rdocs-document-generation': '2' },
          }),
      ),
    );

    const states: string[] = [];
    const transport = new HttpCollaborationTransport({
      pageId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
      document: clientDocument,
      awareness,
      ticket: 'old-generation-ticket',
      renewTicket: async () => 'unused',
      onState: (state) => states.push(state),
      pollIntervalMs: 60_000,
    });

    await transport.start();
    expect(states).toEqual(['rebased']);
    expect(fetch).toHaveBeenCalledTimes(1);

    awareness.destroy();
    clientDocument.destroy();
  });

  it('renews a stale ACL ticket once and resumes syncing', async () => {
    const clientDocument = new Y.Doc();
    const awareness = new Awareness(clientDocument);
    const response = encodeHttpSyncResponse({
      serverUpdate: new Uint8Array(),
      serverStateVector: Y.encodeStateVector(clientDocument),
      awarenessUpdate: new Uint8Array(),
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response(null, { status: 403 }))
        .mockResolvedValueOnce(new Response(toArrayBuffer(response))),
    );
    const renewTicket = vi.fn(async () => 'fresh-acl-ticket');
    const states: string[] = [];
    const transport = new HttpCollaborationTransport({
      pageId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
      document: clientDocument,
      awareness,
      ticket: 'stale-acl-ticket',
      renewTicket,
      onState: (state) => states.push(state),
      pollIntervalMs: 60_000,
    });

    await transport.start();
    await vi.waitFor(() => expect(states).toContain('synced'));
    expect(renewTicket).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    transport.stop();
    awareness.destroy();
    clientDocument.destroy();
  });
});

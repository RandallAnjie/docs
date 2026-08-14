import { afterEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { decodeHttpSyncRequest, encodeHttpSyncResponse, type HttpSyncRequest } from '@rdocs/shared';

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

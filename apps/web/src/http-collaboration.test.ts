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
    await transport.syncNow();
    expect(serverDocument.getText('default').toString()).toBe('server-client');
    expect(requests).toHaveLength(2);
    expect(states).toContain('synced');

    transport.stop();
    awareness.destroy();
    clientDocument.destroy();
    serverDocument.destroy();
  });
});

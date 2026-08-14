import { describe, expect, it } from 'vitest';

import {
  decodeHttpSyncRequest,
  decodeHttpSyncResponse,
  encodeHttpSyncRequest,
  encodeHttpSyncResponse,
} from './http-sync';

describe('HTTP collaboration sync protocol', () => {
  it('round trips requests and responses', () => {
    const request = {
      clientStateVector: new Uint8Array([1, 2]),
      clientUpdate: new Uint8Array([3, 4, 5]),
      awarenessUpdate: new Uint8Array([6]),
    };
    const response = {
      serverUpdate: new Uint8Array([7, 8]),
      serverStateVector: new Uint8Array([9]),
      awarenessUpdate: new Uint8Array([10, 11, 12]),
    };

    expect(decodeHttpSyncRequest(encodeHttpSyncRequest(request))).toEqual(request);
    expect(decodeHttpSyncResponse(encodeHttpSyncResponse(response))).toEqual(response);
  });

  it('rejects truncated and trailing frames', () => {
    const valid = encodeHttpSyncRequest({
      clientStateVector: new Uint8Array([1]),
      clientUpdate: new Uint8Array(),
      awarenessUpdate: new Uint8Array(),
    });

    expect(() => decodeHttpSyncRequest(valid.slice(0, -1))).toThrow('http_sync_truncated');
    expect(() => decodeHttpSyncRequest(new Uint8Array([...valid, 99]))).toThrow(
      'http_sync_trailing_bytes',
    );
  });
});

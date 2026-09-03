import { MAX_COLLAB_UPDATE_BYTES } from './limits';

const HTTP_SYNC_PROTOCOL_VERSION = 1;
const FIELD_COUNT = 3;
const UINT32_BYTES = 4;

export const MAX_HTTP_SYNC_BODY_BYTES = 1 + FIELD_COUNT * (UINT32_BYTES + MAX_COLLAB_UPDATE_BYTES);
export const HTTP_SYNC_FIELD_TOO_LARGE = 'http_sync_field_too_large';

export interface HttpSyncRequest {
  clientStateVector: Uint8Array;
  clientUpdate: Uint8Array;
  awarenessUpdate: Uint8Array;
}

export interface HttpSyncResponse {
  serverUpdate: Uint8Array;
  serverStateVector: Uint8Array;
  awarenessUpdate: Uint8Array;
}

function encodeFields(fields: readonly Uint8Array[]): Uint8Array {
  if (fields.length !== FIELD_COUNT) throw new Error('http_sync_field_count');
  for (const field of fields) {
    if (field.byteLength > MAX_COLLAB_UPDATE_BYTES) throw new Error(HTTP_SYNC_FIELD_TOO_LARGE);
  }

  const size = 1 + fields.reduce((total, field) => total + UINT32_BYTES + field.byteLength, 0);
  const output = new Uint8Array(size);
  const view = new DataView(output.buffer);
  output[0] = HTTP_SYNC_PROTOCOL_VERSION;
  let offset = 1;
  for (const field of fields) {
    view.setUint32(offset, field.byteLength);
    offset += UINT32_BYTES;
    output.set(field, offset);
    offset += field.byteLength;
  }
  return output;
}

function decodeFields(payload: Uint8Array): [Uint8Array, Uint8Array, Uint8Array] {
  if (payload.byteLength < 1 || payload[0] !== HTTP_SYNC_PROTOCOL_VERSION) {
    throw new Error('http_sync_version');
  }

  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fields: Uint8Array[] = [];
  let offset = 1;
  for (let index = 0; index < FIELD_COUNT; index += 1) {
    if (offset + UINT32_BYTES > payload.byteLength) throw new Error('http_sync_truncated');
    const length = view.getUint32(offset);
    offset += UINT32_BYTES;
    if (length > MAX_COLLAB_UPDATE_BYTES) throw new Error(HTTP_SYNC_FIELD_TOO_LARGE);
    if (offset + length > payload.byteLength) throw new Error('http_sync_truncated');
    fields.push(payload.slice(offset, offset + length));
    offset += length;
  }
  if (offset !== payload.byteLength) throw new Error('http_sync_trailing_bytes');
  return fields as [Uint8Array, Uint8Array, Uint8Array];
}

export function encodeHttpSyncRequest(request: HttpSyncRequest): Uint8Array {
  return encodeFields([request.clientStateVector, request.clientUpdate, request.awarenessUpdate]);
}

export function decodeHttpSyncRequest(payload: Uint8Array): HttpSyncRequest {
  const [clientStateVector, clientUpdate, awarenessUpdate] = decodeFields(payload);
  return { clientStateVector, clientUpdate, awarenessUpdate };
}

export function encodeHttpSyncResponse(response: HttpSyncResponse): Uint8Array {
  return encodeFields([
    response.serverUpdate,
    response.serverStateVector,
    response.awarenessUpdate,
  ]);
}

export function decodeHttpSyncResponse(payload: Uint8Array): HttpSyncResponse {
  const [serverUpdate, serverStateVector, awarenessUpdate] = decodeFields(payload);
  return { serverUpdate, serverStateVector, awarenessUpdate };
}

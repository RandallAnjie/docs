import * as Y from 'yjs';

const baseUrl = process.env.RDOCS_SMOKE_URL || 'https://rdocs-randall.edge.bigrandall.io';
const expectedOrigin = process.env.RDOCS_SMOKE_ORIGIN || 'https://docs.bigrandall.io';
const HTTP_SYNC_PROTOCOL_VERSION = 1;
const HTTP_SYNC_FIELD_COUNT = 3;
const UINT32_BYTES = 4;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function toArrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function encodeFields(fields) {
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

function decodeFields(payload) {
  assert(payload[0] === HTTP_SYNC_PROTOCOL_VERSION, 'unexpected HTTP sync protocol version');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const fields = [];
  let offset = 1;
  for (let index = 0; index < HTTP_SYNC_FIELD_COUNT; index += 1) {
    const length = view.getUint32(offset);
    offset += UINT32_BYTES;
    fields.push(payload.slice(offset, offset + length));
    offset += length;
  }
  assert(offset === payload.byteLength, 'unexpected HTTP sync trailing bytes');
  return fields;
}

async function fetchWithCapacityRetry(path, init = {}) {
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (response.status !== 503 || attempt === 5) return response;
    await new Promise((resolve) => setTimeout(resolve, attempt * 500));
  }
  throw new Error('unreachable');
}

async function api(path, init) {
  const response = await fetchWithCapacityRetry(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error || ''}`);
  return body;
}

async function ticket(pageId, actorId) {
  const response = await api(`/api/pages/${pageId}/collab-ticket`, {
    method: 'POST',
    body: JSON.stringify({ actorId, displayName: actorId }),
  });
  return response.ticket;
}

async function sync(pageId, collabTicket, document, knownServerStateVector) {
  const request = encodeFields([
    Y.encodeStateVector(document),
    Y.encodeStateAsUpdate(document, knownServerStateVector),
    new Uint8Array(),
  ]);
  const response = await fetchWithCapacityRetry(`/api/pages/${pageId}/collaboration-sync`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${collabTicket}`,
      'content-type': 'application/octet-stream',
      origin: expectedOrigin,
    },
    body: toArrayBuffer(request),
  });
  if (!response.ok) return { response, serverStateVector: knownServerStateVector };
  const [serverUpdate, serverStateVector] = decodeFields(
    new Uint8Array(await response.arrayBuffer()),
  );
  Y.applyUpdate(document, serverUpdate, 'server');
  return { response, serverStateVector };
}

const created = await api('/api/pages', {
  method: 'POST',
  body: JSON.stringify({ title: 'Revision generation smoke' }),
});
const pageId = created.page.id;
const originalGeneration = created.page.currentGeneration;
const firstTicket = await ticket(pageId, 'revision-smoke-first');
const firstDocument = new Y.Doc();
const firstText = firstDocument.getText('default');
let firstServerStateVector = new Uint8Array([0]);

firstText.insert(0, 'version-a');
({ serverStateVector: firstServerStateVector } = await sync(
  pageId,
  firstTicket,
  firstDocument,
  firstServerStateVector,
));

const baseline = await api(`/api/pages/${pageId}/revisions`, {
  method: 'POST',
  body: JSON.stringify({ label: 'Version A' }),
});
assert(baseline.revision.generation === originalGeneration, 'baseline generation mismatch');

firstText.delete(0, firstText.length);
firstText.insert(0, 'version-b');
({ serverStateVector: firstServerStateVector } = await sync(
  pageId,
  firstTicket,
  firstDocument,
  firstServerStateVector,
));

const restored = await api(`/api/revisions/${baseline.revision.id}/restore`, { method: 'POST' });
assert(
  restored.page.currentGeneration > originalGeneration,
  'restore did not create a new generation',
);
assert(restored.previousRevision.kind === 'restore', 'restore did not preserve current content');

const staleSync = await sync(pageId, firstTicket, firstDocument, firstServerStateVector);
assert(staleSync.response.status === 409, 'old generation ticket was not rejected');
assert(
  staleSync.response.headers.get('x-rdocs-document-generation') ===
    String(restored.page.currentGeneration),
  'old client did not receive the new generation',
);

const restoredTicket = await ticket(pageId, 'revision-smoke-restored');
const restoredDocument = new Y.Doc();
let restoredServerStateVector = new Uint8Array([0]);
({ serverStateVector: restoredServerStateVector } = await sync(
  pageId,
  restoredTicket,
  restoredDocument,
  restoredServerStateVector,
));
assert(
  restoredDocument.getText('default').toString() === 'version-a',
  'restored generation did not contain Version A',
);

restoredDocument.getText('default').insert(9, '-new-generation');
({ serverStateVector: restoredServerStateVector } = await sync(
  pageId,
  restoredTicket,
  restoredDocument,
  restoredServerStateVector,
));
const verificationDocument = new Y.Doc();
await sync(
  pageId,
  await ticket(pageId, 'revision-smoke-verifier'),
  verificationDocument,
  new Uint8Array([0]),
);
assert(
  verificationDocument.getText('default').toString() === 'version-a-new-generation',
  'new generation did not remain writable and persistent',
);

const listed = await api(`/api/pages/${pageId}/revisions`);
assert(
  listed.revisions.some((revision) => revision.id === baseline.revision.id),
  'manual revision missing from list',
);
assert(
  listed.revisions.some((revision) => revision.id === restored.previousRevision.id),
  'pre-restore revision missing from list',
);

firstDocument.destroy();
restoredDocument.destroy();
verificationDocument.destroy();

console.log(
  JSON.stringify({
    ok: true,
    pageId,
    revisionId: baseline.revision.id,
    originalGeneration,
    restoredGeneration: restored.page.currentGeneration,
    checks: [
      'manual revision snapshot',
      'pre-restore revision',
      'new generation initialization',
      'old ticket rejection',
      'restored content isolation',
      'new generation persistence',
    ],
  }),
);

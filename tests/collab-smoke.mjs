import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import WebSocket from 'ws';
import * as Y from 'yjs';

const baseUrl = process.env.RDOCS_SMOKE_URL || 'https://docs.bigrandall.io';
const expectedOrigin = process.env.RDOCS_SMOKE_ORIGIN || 'https://docs.bigrandall.io';
const adminSecret = process.env.RDOCS_SMOKE_ADMIN_SECRET || '';
const wsBaseUrl = baseUrl.replace(/^http/, 'ws');
const debug = process.env.RDOCS_SMOKE_DEBUG === '1';

const MESSAGE_SYNC = 0;
const SYNC_STEP_1 = 0;
const SYNC_STEP_2 = 1;
const SYNC_UPDATE = 2;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function api(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${path}: ${response.status} ${body.error || ''}`);
  return body;
}

function syncFrame(type, payload) {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  encoding.writeVarUint(encoder, type);
  encoding.writeVarUint8Array(encoder, payload);
  return encoding.toUint8Array(encoder);
}

async function ticket(pageId, actorId) {
  const body = await api(`/api/pages/${pageId}/collab-ticket`, {
    method: 'POST',
    body: JSON.stringify({ actorId, displayName: actorId }),
  });
  return body.ticket;
}

async function connect(pageId, actorId) {
  const doc = new Y.Doc();
  const collabTicket = await ticket(pageId, actorId);
  const socket = new WebSocket(
    `${wsBaseUrl}/collab/${pageId}?ticket=${encodeURIComponent(collabTicket)}`,
    { origin: expectedOrigin },
  );

  socket.binaryType = 'arraybuffer';
  socket.on('message', (raw) => {
    const message = new Uint8Array(raw);
    const decoder = decoding.createDecoder(message);
    const outerType = decoding.readVarUint(decoder);
    if (outerType !== MESSAGE_SYNC) {
      if (debug) console.error(actorId, 'received non-sync message', outerType, message.byteLength);
      return;
    }
    const type = decoding.readVarUint(decoder);
    const payload = decoding.readVarUint8Array(decoder);
    if (debug) console.error(actorId, 'received sync message', type, payload.byteLength);
    if (type === SYNC_STEP_1) {
      socket.send(syncFrame(SYNC_STEP_2, Y.encodeStateAsUpdate(doc, payload)));
    } else if (type === SYNC_STEP_2 || type === SYNC_UPDATE) {
      Y.applyUpdate(doc, payload, socket);
    }
  });

  doc.on('update', (update, origin) => {
    if (origin !== socket && socket.readyState === WebSocket.OPEN) {
      if (debug) console.error(actorId, 'sending update', update.byteLength);
      socket.send(syncFrame(SYNC_UPDATE, update));
    }
  });

  socket.on('close', (code, reason) => {
    if (debug) console.error(actorId, 'closed', code, reason.toString());
  });
  socket.on('error', (reason) => {
    if (debug) console.error(actorId, 'error', reason.message);
  });
  socket.on('unexpected-response', (_request, response) => {
    if (!debug) return;
    const chunks = [];
    response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => {
      console.error(actorId, 'unexpected response body', Buffer.concat(chunks).toString());
    });
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${actorId}: WebSocket open timeout`)), 15_000);
    socket.once('open', () => {
      clearTimeout(timer);
      socket.send(syncFrame(SYNC_STEP_1, Y.encodeStateVector(doc)));
      resolve();
    });
    socket.once('error', reject);
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  return { doc, socket };
}

async function waitFor(predicate, message, timeoutMs = 12_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const created = await api('/api/pages', {
  method: 'POST',
  body: JSON.stringify({ title: 'Realtime smoke test' }),
});
const pageId = created.page.id;
const first = await connect(pageId, 'smoke-alice');
await new Promise((resolve) => setTimeout(resolve, 2_000));
const second = await connect(pageId, 'smoke-bob');
const sharedText = first.doc.getText('default');
const marker = `Rdocs realtime ${crypto.randomUUID()}`;

sharedText.insert(0, marker);
await waitFor(
  () => second.doc.getText('default').toString() === marker,
  'second client did not converge',
);

first.socket.close(1000, 'reconnect test');
second.socket.close(1000, 'reconnect test');
await new Promise((resolve) => setTimeout(resolve, 500));

const restored = await connect(pageId, 'smoke-carol');
await waitFor(
  () => restored.doc.getText('default').toString() === marker,
  'reconnected client did not restore persisted content',
);

let revokedCloseCode = 0;
restored.socket.once('close', (code) => {
  revokedCloseCode = code;
});
await api(`/api/pages/${pageId}/collaboration-access`, {
  method: 'POST',
  headers: { authorization: `Bearer ${adminSecret}` },
  body: JSON.stringify({ enabled: false }),
});
await waitFor(() => revokedCloseCode === 4403, 'permission revocation did not close live socket');

await api(`/api/pages/${pageId}/collaboration-access`, {
  method: 'POST',
  headers: { authorization: `Bearer ${adminSecret}` },
  body: JSON.stringify({ enabled: true }),
});

assert(second.doc.getText('default').toString() === marker, 'local convergence state was lost');
console.log(
  JSON.stringify({
    ok: true,
    pageId,
    checks: ['two-client convergence', 'DO persistence', 'reconnect restore', 'live revocation'],
  }),
);

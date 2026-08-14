export interface CollabTicketPayload {
  version: 1;
  pageId: string;
  generation: number;
  actorId: string;
  displayName: string;
  role: 'editor' | 'viewer';
  aclVersion: number;
  issuedAt: number;
  expiresAt: number;
}

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/');
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function keyFor(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signCollabTicket(
  payload: CollabTicketPayload,
  secret: string,
): Promise<string> {
  const body = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await keyFor(secret), encoder.encode(body));
  return `${body}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyCollabTicket(
  ticket: string,
  secret: string,
  now = Date.now(),
): Promise<CollabTicketPayload | null> {
  const [body, signature, ...rest] = ticket.split('.');
  if (!body || !signature || rest.length > 0) return null;

  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await keyFor(secret),
      toArrayBuffer(base64UrlToBytes(signature)),
      encoder.encode(body),
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(body)),
    ) as CollabTicketPayload;
    if (payload.version !== 1 || payload.expiresAt <= now || payload.issuedAt > now + 30_000)
      return null;
    return payload;
  } catch {
    return null;
  }
}

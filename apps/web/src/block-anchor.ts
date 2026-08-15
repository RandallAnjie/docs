import * as Y from 'yjs';

export const BLOCK_ANCHOR_PARAMETER = 'block';
const MAX_ENCODED_POSITION_LENGTH = 4_096;

export function encodeRelativePosition(position: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(position);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function decodeRelativePosition(value: string): Y.RelativePosition | null {
  if (!value || value.length > MAX_ENCODED_POSITION_LENGTH || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null;
  }
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
}

export function blockAnchorFromHash(hash: string): Y.RelativePosition | null {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  const value = parameters.get(BLOCK_ANCHOR_PARAMETER);
  return value ? decodeRelativePosition(value) : null;
}

export function blockAnchorUrl(origin: string, pageId: string, encodedPosition: string): string {
  const url = new URL(`/p/${encodeURIComponent(pageId)}`, origin);
  url.hash = new URLSearchParams({ [BLOCK_ANCHOR_PARAMETER]: encodedPosition }).toString();
  return url.toString();
}

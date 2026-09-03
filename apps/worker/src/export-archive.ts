import { markdownToFlowHtml } from '@rdocs/shared';

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Uint8Array {
  const view = new Uint8Array(2);
  new DataView(view.buffer).setUint16(0, value, true);
  return view;
}

function u32(value: number): Uint8Array {
  const view = new Uint8Array(4);
  new DataView(view.buffer).setUint32(0, value, true);
  return view;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export function zipStore(files: Array<{ name: string; body: string }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = new TextEncoder().encode(file.name.replace(/\\/g, '/'));
    const body = new TextEncoder().encode(file.body);
    const checksum = crc32(body);
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(body.byteLength),
      u32(body.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      body,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(body.byteLength),
      u32(body.byteLength),
      u16(name.byteLength),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.byteLength;
  }
  const centralSize = centrals.reduce((total, part) => total + part.byteLength, 0);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, ...centrals, end]);
}

function readU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzipEntries(
  bytes: Uint8Array,
): Promise<Array<{ body: string; name: string }>> {
  const files: Array<{ body: string; name: string }> = [];
  let offset = 0;
  while (offset + 30 <= bytes.byteLength && readU32(bytes, offset) === 0x04034b50) {
    const method = readU16(bytes, offset + 8);
    const compressed = readU32(bytes, offset + 18);
    const nameLength = readU16(bytes, offset + 26);
    const extraLength = readU16(bytes, offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressed;
    if (dataEnd > bytes.byteLength) break;
    const name = new TextDecoder().decode(bytes.slice(nameStart, nameStart + nameLength));
    const payload = bytes.slice(dataStart, dataEnd);
    let raw = new Uint8Array(payload.byteLength);
    raw.set(payload);
    if (method === 8) {
      const inflated = await inflateRaw(payload);
      raw = new Uint8Array(inflated.byteLength);
      raw.set(inflated);
    } else if (method !== 0) {
      offset = dataEnd;
      continue;
    }
    const safeName = name.replace(/\\/g, '/');
    if (!name.endsWith('/') && !safeName.includes('..') && !safeName.startsWith('/')) {
      files.push({ name: safeName, body: new TextDecoder().decode(raw) });
    }
    offset = dataEnd;
  }
  return files;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

export function markdownToHtmlDocument(title: string, markdown: string): string {
  const body = markdownToFlowHtml(markdown);
  const safeTitle = escapeHtml(title);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" /><title>${safeTitle}</title>
<style>body{font:16px/1.6 system-ui,sans-serif;max-width:720px;margin:40px auto;color:#222}code{background:#f4f2ed;padding:1px 4px}</style>
</head><body>${body}</body></html>`;
}

export function simplePdf(title: string, text: string): Uint8Array {
  const safe = `${title}\n\n${text}`.replace(/[()\\]/g, ' ').slice(0, 20_000);
  const lines = safe.split('\n').slice(0, 60);
  const ops = ['BT', '/F1 12 Tf', '50 780 Td', '14 TL'];
  for (const [index, line] of lines.entries()) {
    if (index) ops.push('T*');
    ops.push('(' + line.slice(0, 90) + ') Tj');
  }
  ops.push('ET');
  const content = ops.join('\n');
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
  ];
  let offset = 9;
  const offsets = [0];
  const chunks = ['%PDF-1.4\n'];
  for (const object of objects) {
    offsets.push(offset);
    chunks.push(`${object}\n`);
    offset += object.length + 1;
  }
  const xref = offset;
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (const position of offsets.slice(1)) {
    chunks.push(`${String(position).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`);
  return new TextEncoder().encode(chunks.join(''));
}

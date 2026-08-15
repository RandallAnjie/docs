export interface ParsedByteRange {
  end: number;
  length: number;
  offset: number;
}

export function parseByteRange(value: string, size: number): ParsedByteRange | null {
  if (!Number.isSafeInteger(size) || size <= 0 || value.includes(',')) return null;
  const match = value.trim().match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return null;
  const startText = match[1] ?? '';
  const endText = match[2] ?? '';
  if (!startText && !endText) return null;

  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    const length = Math.min(suffix, size);
    return { offset: size - length, end: size - 1, length };
  }

  const offset = Number(startText);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= size) return null;
  const requestedEnd = endText ? Number(endText) : size - 1;
  if (!Number.isSafeInteger(requestedEnd) || requestedEnd < offset) return null;
  const end = Math.min(requestedEnd, size - 1);
  return { offset, end, length: end - offset + 1 };
}

import { describe, expect, it } from 'vitest';

import { parseByteRange } from './attachment-range';

describe('attachment byte ranges', () => {
  it('parses bounded and open-ended byte ranges', () => {
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ offset: 10, end: 19, length: 10 });
    expect(parseByteRange('bytes=90-', 100)).toEqual({ offset: 90, end: 99, length: 10 });
    expect(parseByteRange('bytes=95-500', 100)).toEqual({ offset: 95, end: 99, length: 5 });
  });

  it('parses suffix ranges', () => {
    expect(parseByteRange('bytes=-12', 100)).toEqual({ offset: 88, end: 99, length: 12 });
    expect(parseByteRange('bytes=-500', 100)).toEqual({ offset: 0, end: 99, length: 100 });
  });

  it('rejects malformed, multiple and unsatisfiable ranges', () => {
    expect(parseByteRange('bytes=100-', 100)).toBeNull();
    expect(parseByteRange('bytes=20-10', 100)).toBeNull();
    expect(parseByteRange('bytes=0-1,4-5', 100)).toBeNull();
    expect(parseByteRange('items=0-10', 100)).toBeNull();
  });
});

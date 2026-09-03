import { describe, expect, it } from 'vitest';

import { namedSpaceIcon } from './space-icon';

describe('namedSpaceIcon', () => {
  it('maps the default general space lucide name', () => {
    expect(namedSpaceIcon('book-open')).not.toBeNull();
    expect(namedSpaceIcon('Book_Open')).not.toBeNull();
  });

  it('ignores blank values and keeps emoji glyphs as unnamed', () => {
    expect(namedSpaceIcon(null)).toBeNull();
    expect(namedSpaceIcon('')).toBeNull();
    expect(namedSpaceIcon('📘')).toBeNull();
  });
});

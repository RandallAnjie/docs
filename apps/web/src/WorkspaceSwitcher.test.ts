import { describe, expect, it } from 'vitest';

import { firstCharacter } from './WorkspaceSwitcher';

describe('firstCharacter', () => {
  it('uses the first visible character for Chinese names', () => {
    expect(firstCharacter(' 安洁 ')).toBe('安');
  });

  it('uppercases latin initials', () => {
    expect(firstCharacter('randall')).toBe('R');
  });

  it('keeps a full unicode code point and supports a fallback', () => {
    expect(firstCharacter('🦊 Fox')).toBe('🦊');
    expect(firstCharacter('', 'R')).toBe('R');
  });
});

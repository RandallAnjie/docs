import { describe, expect, it } from 'vitest';

import { pointerInBlockHandleKeepZone } from './EditorBlockHandle';

const handle = { left: 40, top: 80, right: 110, bottom: 108 };
const node = { left: 120, top: 80, right: 640, bottom: 320 };

describe('pointerInBlockHandleKeepZone', () => {
  it('keeps the handle while the pointer is on it', () => {
    expect(pointerInBlockHandleKeepZone(70, 94, handle, node)).toBe(true);
  });

  it('keeps the handle across the gutter between the block and the handle', () => {
    expect(pointerInBlockHandleKeepZone(115, 94, handle, node)).toBe(true);
    expect(pointerInBlockHandleKeepZone(140, 200, handle, node)).toBe(true);
  });

  it('does not freeze the handle while the pointer is in the middle of the block', () => {
    expect(pointerInBlockHandleKeepZone(400, 200, handle, node)).toBe(false);
  });

  it('releases the handle once the pointer leaves the block and the gutter', () => {
    expect(pointerInBlockHandleKeepZone(10, 94, handle, node)).toBe(false);
    expect(pointerInBlockHandleKeepZone(400, 40, handle, node)).toBe(false);
  });
});

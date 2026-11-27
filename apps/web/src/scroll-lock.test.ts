import { describe, expect, it } from 'vitest';

import { OVERLAY_SELECTOR, wheelScrollsWithin, type ScrollBox } from './scroll-lock';

const box = (overrides: Partial<ScrollBox>): ScrollBox => ({
  scrollTop: 0,
  scrollLeft: 0,
  scrollHeight: 100,
  scrollWidth: 100,
  clientHeight: 100,
  clientWidth: 100,
  overflowX: 'visible',
  overflowY: 'visible',
  ...overrides,
});

describe('scroll lock', () => {
  it('lets a scrollable list inside a layer scroll until its edge', () => {
    const list = box({ overflowY: 'auto', scrollHeight: 400, clientHeight: 200, scrollTop: 100 });
    expect(wheelScrollsWithin([list], 0, 40)).toBe(true);
    expect(wheelScrollsWithin([list], 0, -40)).toBe(true);
  });

  it('stops at the edges instead of scrolling the page behind', () => {
    const atBottom = box({
      overflowY: 'auto',
      scrollHeight: 400,
      clientHeight: 200,
      scrollTop: 200,
    });
    expect(wheelScrollsWithin([atBottom], 0, 40)).toBe(false);
    const atTop = box({ overflowY: 'auto', scrollHeight: 400, clientHeight: 200, scrollTop: 0 });
    expect(wheelScrollsWithin([atTop], 0, -40)).toBe(false);
  });

  it('ignores boxes that do not scroll, and checks outer boxes in the layer', () => {
    const plain = box({});
    const outer = box({ overflowY: 'scroll', scrollHeight: 300, clientHeight: 100 });
    expect(wheelScrollsWithin([plain], 0, 40)).toBe(false);
    expect(wheelScrollsWithin([plain, outer], 0, 40)).toBe(true);
  });

  it('handles horizontal scrolling', () => {
    const wide = box({ overflowX: 'auto', scrollWidth: 500, clientWidth: 200, scrollLeft: 0 });
    expect(wheelScrollsWithin([wide], 30, 0)).toBe(true);
    expect(wheelScrollsWithin([wide], -30, 0)).toBe(false);
  });

  it('treats menus, popovers, dialogs and the side peek as layers', () => {
    for (const name of [
      '.dialog-backdrop',
      '.database-record-drawer',
      '.slash-menu',
      '.floating-layer',
    ]) {
      expect(OVERLAY_SELECTOR).toContain(name);
    }
    expect(OVERLAY_SELECTOR).not.toContain('editor-selection-toolbar');
  });
});

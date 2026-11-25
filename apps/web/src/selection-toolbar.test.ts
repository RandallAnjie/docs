import { describe, expect, it } from 'vitest';

import { placeSelectionToolbar, selectionRect } from './selection-toolbar';

const viewport = { viewportWidth: 1200, viewportHeight: 800 };

describe('selection toolbar placement', () => {
  it('sits above the selection when there is room', () => {
    const placed = placeSelectionToolbar({
      selection: { top: 300, bottom: 322, left: 500, right: 600 },
      width: 400,
      height: 40,
      ...viewport,
    });
    expect(placed).toEqual({ left: 350, top: 252, placement: 'above' });
    expect(placed.top + 40).toBeLessThanOrEqual(300);
  });

  it('uses its measured height, so a taller toolbar still clears the text', () => {
    const placed = placeSelectionToolbar({
      selection: { top: 300, bottom: 322, left: 500, right: 600 },
      width: 400,
      height: 76,
      ...viewport,
    });
    expect(placed.top + 76).toBeLessThanOrEqual(300);
  });

  it('flips below a selection near the top instead of covering it', () => {
    const placed = placeSelectionToolbar({
      selection: { top: 30, bottom: 52, left: 500, right: 600 },
      width: 400,
      height: 40,
      ...viewport,
    });
    expect(placed.placement).toBe('below');
    expect(placed.top).toBeGreaterThanOrEqual(52);
  });

  it('respects a sticky header inset', () => {
    const placed = placeSelectionToolbar({
      selection: { top: 80, bottom: 102, left: 500, right: 600 },
      width: 400,
      height: 40,
      topInset: 46,
      ...viewport,
    });
    expect(placed.placement).toBe('below');
  });

  it('stays inside the viewport horizontally', () => {
    expect(
      placeSelectionToolbar({
        selection: { top: 300, bottom: 322, left: 2, right: 20 },
        width: 400,
        height: 40,
        ...viewport,
      }).left,
    ).toBe(8);
    expect(
      placeSelectionToolbar({
        selection: { top: 300, bottom: 322, left: 1180, right: 1198 },
        width: 400,
        height: 40,
        ...viewport,
      }).left,
    ).toBe(792);
  });

  it('measures a multi-line selection from its first to last line', () => {
    expect(
      selectionRect(
        { top: 100, bottom: 120, left: 600, right: 600 },
        { top: 140, bottom: 160, left: 300, right: 300 },
      ),
    ).toEqual({ top: 100, bottom: 160, left: 300, right: 600 });
  });
});

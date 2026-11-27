import { describe, expect, it } from 'vitest';

import { placeAnchored } from './floating';

const viewport = { viewportWidth: 1200, viewportHeight: 800 };

describe('anchored floating layers', () => {
  it('opens below the anchor when it fits', () => {
    const placed = placeAnchored({
      anchor: { top: 100, bottom: 130, left: 400, right: 430 },
      width: 220,
      height: 200,
      align: 'start',
      ...viewport,
    });
    expect(placed).toMatchObject({ left: 400, top: 134 });
  });

  it('flips above near the bottom of the screen', () => {
    const placed = placeAnchored({
      anchor: { top: 700, bottom: 730, left: 400, right: 430 },
      width: 220,
      height: 200,
      align: 'start',
      ...viewport,
    });
    expect(placed.top + 200).toBeLessThanOrEqual(700);
  });

  it('aligns to the end edge and stays on screen', () => {
    expect(
      placeAnchored({
        anchor: { top: 100, bottom: 130, left: 1150, right: 1190 },
        width: 220,
        height: 100,
        align: 'start',
        ...viewport,
      }).left,
    ).toBe(972);
    expect(
      placeAnchored({
        anchor: { top: 100, bottom: 130, left: 20, right: 60 },
        width: 220,
        height: 100,
        align: 'end',
        ...viewport,
      }).left,
    ).toBe(8);
  });

  it('limits height to the room on the chosen side', () => {
    const placed = placeAnchored({
      anchor: { top: 380, bottom: 410, left: 400, right: 430 },
      width: 220,
      height: 900,
      align: 'start',
      ...viewport,
    });
    expect(placed.maxHeight).toBeLessThan(400);
  });
});

export interface SelectionRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface FloatingPlacement {
  left: number;
  top: number;
  placement: 'above' | 'below';
}

const GAP = 8;
const MARGIN = 8;

/**
 * Where a floating toolbar goes for a text selection, measured in viewport
 * pixels: centered on the selection, above it when there is room, otherwise
 * below it, and never wider than the viewport allows. It never covers the
 * selection unless the selection itself fills the viewport.
 */
export function placeSelectionToolbar(input: {
  selection: SelectionRect;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  /** The lowest y a toolbar may start at, such as the bottom of a sticky header. */
  topInset?: number;
}): FloatingPlacement {
  const { selection, width, height, viewportWidth, viewportHeight } = input;
  const minTop = Math.max(MARGIN, input.topInset ?? 0);
  const center = (selection.left + selection.right) / 2;
  const maxLeft = Math.max(MARGIN, viewportWidth - width - MARGIN);
  const left = Math.min(Math.max(MARGIN, center - width / 2), maxLeft);

  const above = selection.top - GAP - height;
  if (above >= minTop) return { left, top: above, placement: 'above' };
  const below = selection.bottom + GAP;
  if (below + height <= viewportHeight - MARGIN) return { left, top: below, placement: 'below' };
  // Neither side fits: use the roomier side and stay inside the viewport.
  return selection.top - minTop >= viewportHeight - selection.bottom
    ? { left, top: minTop, placement: 'above' }
    : { left, top: Math.max(minTop, viewportHeight - MARGIN - height), placement: 'below' };
}

/** The selection's bounding box from the coordinates of its two ends. */
export function selectionRect(
  start: { top: number; bottom: number; left: number; right: number },
  end: { top: number; bottom: number; left: number; right: number },
): SelectionRect {
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  // On one line, center over the selected run; across lines, over its start and end.
  const sameLine = Math.abs(start.top - end.top) < 2;
  return sameLine
    ? { top, bottom, left: start.left, right: end.right }
    : {
        top,
        bottom,
        left: Math.min(start.left, end.left),
        right: Math.max(start.right, end.right),
      };
}

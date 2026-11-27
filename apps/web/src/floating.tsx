import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 8;
const GAP = 4;

export interface AnchoredPosition {
  left: number;
  top: number;
  maxHeight: number;
}

/**
 * Place a floating box against an anchor rect inside the viewport: below the
 * anchor when it fits (or when there is more room below), otherwise above;
 * aligned to the anchor's start or end edge and kept on screen.
 */
export function placeAnchored(input: {
  anchor: { top: number; bottom: number; left: number; right: number };
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  align: 'start' | 'end';
}): AnchoredPosition {
  const { anchor, width, height, viewportWidth, viewportHeight, align } = input;
  const below = viewportHeight - anchor.bottom - GAP - MARGIN;
  const above = anchor.top - GAP - MARGIN;
  const placeBelow = height <= below || below >= above;
  const maxHeight = Math.max(120, placeBelow ? below : above);
  const shownHeight = Math.min(height, maxHeight);
  const top = placeBelow ? anchor.bottom + GAP : anchor.top - GAP - shownHeight;
  const preferred = align === 'end' ? anchor.right - width : anchor.left;
  const left = Math.min(
    Math.max(MARGIN, preferred),
    Math.max(MARGIN, viewportWidth - width - MARGIN),
  );
  return { left, top: Math.max(MARGIN, top), maxHeight };
}

/**
 * A menu or popover rendered into <body> so no scroll container or stacking
 * context can clip or cover it. Closes on outside pointer down and Escape.
 */
export function Floating({
  anchor,
  open,
  onClose,
  align = 'start',
  className = '',
  role = 'menu',
  children,
}: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  align?: 'start' | 'end';
  className?: string;
  role?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<AnchoredPosition | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor || !box.current) {
      setPosition(null);
      return;
    }
    const place = () => {
      if (!box.current) return;
      const rect = anchor.getBoundingClientRect();
      setPosition(
        placeAnchored({
          anchor: rect,
          width: box.current.offsetWidth,
          height: box.current.scrollHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          align,
        }),
      );
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [align, anchor, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (box.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchor, onClose, open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={box}
      role={role}
      className={`floating-layer ${className}`}
      style={{
        position: 'fixed',
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        maxHeight: position?.maxHeight,
        visibility: position ? 'visible' : 'hidden',
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

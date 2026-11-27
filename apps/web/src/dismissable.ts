import { useEffect, useRef } from 'react';

/**
 * One stack for every menu and popover, like Notion: opening one closes the
 * others unless it was opened from inside one (a sub-menu stays with its
 * parent). A pointer down closes everything above the layer it lands in,
 * and Escape closes the top layer. Listeners run in the capture phase, so a
 * component that stops propagation cannot keep a stale menu open.
 */
export interface DismissableLayer {
  close: () => void;
  /** Elements that count as inside: the layer itself and its trigger. */
  elements: () => ReadonlyArray<Element | null | undefined>;
}

const stack: DismissableLayer[] = [];
let installed = false;

function contains(layer: DismissableLayer, node: Node): boolean {
  return layer.elements().some((element) => element?.contains(node));
}

/** Index of the deepest open layer containing `node`, or -1. */
export function deepestLayerContaining(layers: readonly DismissableLayer[], node: Node): number {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    if (contains(layers[index]!, node)) return index;
  }
  return -1;
}

function closeAbove(index: number) {
  for (const layer of stack.slice(index + 1).reverse()) layer.close();
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!stack.length || !(event.target instanceof Node)) return;
      closeAbove(deepestLayerContaining(stack, event.target));
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !stack.length) return;
      stack[stack.length - 1]!.close();
    },
    true,
  );
}

/** Register a layer while it is open; returns a function that removes it. */
export function openLayer(layer: DismissableLayer, opener?: Element | null): () => void {
  install();
  // Opened from inside an open layer: a child of it. Otherwise it replaces
  // every open layer.
  const parent = opener ? deepestLayerContaining(stack, opener) : -1;
  closeAbove(parent);
  stack.push(layer);
  return () => {
    const index = stack.indexOf(layer);
    if (index >= 0) stack.splice(index, 1);
  };
}

/** Number of open layers (for tests and debugging). */
export function openLayerCount(): number {
  return stack.length;
}

/**
 * Keep a component's menu in the shared stack while `open`. `elements`
 * returns what counts as inside (menu and trigger). `opener` (default: the
 * first element) decides whether it was opened from inside another layer —
 * pass the trigger for menus rendered elsewhere, such as into <body>.
 */
export function useDismissable(
  open: boolean,
  close: () => void,
  elements: () => ReadonlyArray<Element | null | undefined>,
  opener?: () => Element | null | undefined,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  const elementsRef = useRef(elements);
  elementsRef.current = elements;
  const openerRef = useRef(opener);
  openerRef.current = opener;
  useEffect(() => {
    if (!open) return;
    const opener =
      (openerRef.current ? openerRef.current() : elementsRef.current().find(Boolean)) ?? null;
    return openLayer(
      { close: () => closeRef.current(), elements: () => elementsRef.current() },
      opener,
    );
  }, [open]);
}

import { afterEach, describe, expect, it } from 'vitest';

import {
  deepestLayerContaining,
  openLayer,
  openLayerCount,
  type DismissableLayer,
} from './dismissable';

class FakeNode {
  constructor(readonly parent: FakeNode | null = null) {}
  contains(node: unknown): boolean {
    for (let current = node as FakeNode | null; current; current = current.parent) {
      if (current === this) return true;
    }
    return false;
  }
}

function layer(element: FakeNode, closed: string[], name: string) {
  const entry: DismissableLayer & { remove?: () => void } = {
    close: () => {
      closed.push(name);
      entry.remove?.();
    },
    elements: () => [element as unknown as Element],
  };
  return entry;
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe('dismissable layers', () => {
  it('opening a top-level layer closes the open one', () => {
    const closed: string[] = [];
    const first = layer(new FakeNode(), closed, 'first');
    first.remove = openLayer(first);
    cleanups.push(first.remove);
    const second = layer(new FakeNode(), closed, 'second');
    second.remove = openLayer(second);
    cleanups.push(second.remove);
    expect(closed).toEqual(['first']);
    expect(openLayerCount()).toBe(1);
  });

  it('keeps the parent when a layer opens from inside it', () => {
    const closed: string[] = [];
    const parentElement = new FakeNode();
    const parent = layer(parentElement, closed, 'parent');
    parent.remove = openLayer(parent);
    cleanups.push(parent.remove);
    const trigger = new FakeNode(parentElement);
    const child = layer(new FakeNode(), closed, 'child');
    child.remove = openLayer(child, trigger as unknown as Element);
    cleanups.push(child.remove);
    expect(closed).toEqual([]);
    expect(openLayerCount()).toBe(2);
    expect(deepestLayerContaining([parent, child], trigger as unknown as Node)).toBe(0);
  });
});

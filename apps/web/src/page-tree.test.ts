import { describe, expect, it } from 'vitest';

import type { PageSummary } from '@rdocs/shared';

import { ancestorPageIds, buildPageTree, descendantPageIds } from './page-tree';

function page(id: string, parentId: string | null): PageSummary {
  return {
    id,
    parentId,
    organizationId: 'org',
    spaceId: 'space',
    title: id,
    icon: null,
    coverAttachmentId: null,
    fontStyle: 'sans',
    isFullWidth: false,
    isSmallText: false,
    isLocked: false,
    currentGeneration: 1,
    editorSchemaVersion: 1,
    updatedAt: 1,
    collaborationEnabled: true,
    aclVersion: 1,
  };
}

describe('page tree', () => {
  it('preserves source order and nests descendants', () => {
    const pages = [
      page('root-a', null),
      page('child-a', 'root-a'),
      page('grandchild-a', 'child-a'),
      page('root-b', null),
    ];
    const tree = buildPageTree(pages);

    expect(tree.map((node) => node.id)).toEqual(['root-a', 'root-b']);
    expect(tree[0]?.children[0]?.id).toBe('child-a');
    expect(tree[0]?.children[0]?.children[0]?.id).toBe('grandchild-a');
    expect([...ancestorPageIds('grandchild-a', pages)]).toEqual(['child-a', 'root-a']);
    expect([...descendantPageIds('root-a', pages)]).toEqual(['child-a', 'grandchild-a']);
  });

  it('keeps orphaned and cyclic nodes reachable at the root', () => {
    const tree = buildPageTree([
      page('orphan', 'missing'),
      page('self', 'self'),
      page('cycle-a', 'cycle-b'),
      page('cycle-b', 'cycle-a'),
    ]);

    expect(tree.map((node) => node.id)).toEqual(['orphan', 'self', 'cycle-a', 'cycle-b']);
  });
});

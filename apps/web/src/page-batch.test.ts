import { describe, expect, it } from 'vitest';

import type { PageSummary } from '@rdocs/shared';

import {
  canManagePageStructure,
  selectedPageRootIds,
  unavailableBatchMoveTargetIds,
} from './page-batch';

function page(
  id: string,
  parentId: string | null,
  role: PageSummary['role'] = 'editor',
): PageSummary {
  return {
    id,
    organizationId: 'org',
    spaceId: 'space',
    parentId,
    title: id,
    icon: null,
    coverAttachmentId: null,
    fontStyle: 'sans',
    isFullWidth: false,
    isSmallText: false,
    isLocked: false,
    currentGeneration: 1,
    editorSchemaVersion: 8,
    updatedAt: 1,
    collaborationEnabled: true,
    aclVersion: 1,
    role,
  };
}

describe('page batch selection', () => {
  const pages = [
    page('root', null),
    page('child', 'root'),
    page('grandchild', 'child'),
    page('other', null),
  ];

  it('collapses selected descendants into one subtree operation', () => {
    expect(selectedPageRootIds(pages, new Set(['root', 'child', 'other']))).toEqual([
      'root',
      'other',
    ]);
  });

  it('rejects selected pages and their descendants as move destinations', () => {
    expect([...unavailableBatchMoveTargetIds(pages, new Set(['child']))]).toEqual([
      'child',
      'grandchild',
    ]);
  });

  it('allows only editors and page administrators to change structure', () => {
    expect(canManagePageStructure(page('editor', null, 'editor'))).toBe(true);
    expect(canManagePageStructure(page('admin', null, 'space_admin'))).toBe(true);
    expect(canManagePageStructure(page('commenter', null, 'commenter'))).toBe(false);
    expect(canManagePageStructure(page('viewer', null, 'viewer'))).toBe(false);
  });
});

import type { PageSummary } from '@rdocs/shared';

export function canManagePageStructure(page: PageSummary): boolean {
  return page.role === 'editor' || page.role === 'space_admin';
}

export function selectedPageRootIds(
  pages: ReadonlyArray<PageSummary>,
  selectedIds: ReadonlySet<string>,
): string[] {
  const byId = new Map(pages.map((page) => [page.id, page]));
  return pages.flatMap((page) => {
    if (!selectedIds.has(page.id)) return [];
    const seen = new Set<string>([page.id]);
    let parentId = page.parentId;
    while (parentId) {
      if (selectedIds.has(parentId)) return [];
      if (seen.has(parentId)) break;
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    return [page.id];
  });
}

export function unavailableBatchMoveTargetIds(
  pages: ReadonlyArray<PageSummary>,
  selectedIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const unavailable = new Set<string>(selectedIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const page of pages) {
      if (page.parentId && unavailable.has(page.parentId) && !unavailable.has(page.id)) {
        unavailable.add(page.id);
        changed = true;
      }
    }
  }
  return unavailable;
}

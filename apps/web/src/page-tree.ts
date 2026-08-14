import type { PageSummary } from '@rdocs/shared';

export interface PageTreeNode extends PageSummary {
  children: PageTreeNode[];
}

function hasSafeParent(page: PageSummary, pagesById: ReadonlyMap<string, PageSummary>): boolean {
  if (!page.parentId || page.parentId === page.id || !pagesById.has(page.parentId)) return false;

  const visited = new Set([page.id]);
  let currentId: string | null = page.parentId;
  while (currentId) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = pagesById.get(currentId)?.parentId ?? null;
  }
  return true;
}

export function buildPageTree(pages: readonly PageSummary[]): PageTreeNode[] {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const nodesById = new Map<string, PageTreeNode>(
    pages.map((page): [string, PageTreeNode] => [page.id, { ...page, children: [] }]),
  );
  const roots: PageTreeNode[] = [];

  for (const page of pages) {
    const node = nodesById.get(page.id);
    if (!node) continue;
    if (hasSafeParent(page, pagesById)) {
      nodesById.get(page.parentId!)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function ancestorPageIds(
  pageId: string,
  pages: readonly PageSummary[],
): ReadonlySet<string> {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const ancestors = new Set<string>();
  let parentId = pagesById.get(pageId)?.parentId ?? null;
  while (parentId && !ancestors.has(parentId)) {
    ancestors.add(parentId);
    parentId = pagesById.get(parentId)?.parentId ?? null;
  }
  return ancestors;
}

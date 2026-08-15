import type { PageSummary } from '@rdocs/shared';

export interface PageTreeNode extends PageSummary {
  children: PageTreeNode[];
}

export interface PageBreadcrumbItem {
  id: string;
  title: string;
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

export function pageBreadcrumbItems(
  pageId: string,
  pages: readonly PageSummary[],
): PageBreadcrumbItem[] {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const path: PageBreadcrumbItem[] = [];
  const visited = new Set<string>();
  let current = pagesById.get(pageId);
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift({ id: current.id, title: current.title || '无标题' });
    current = current.parentId ? pagesById.get(current.parentId) : undefined;
  }
  return path;
}

export function descendantPageIds(
  pageId: string,
  pages: readonly PageSummary[],
): ReadonlySet<string> {
  const children = new Map<string, string[]>();
  for (const page of pages) {
    if (!page.parentId) continue;
    const current = children.get(page.parentId) ?? [];
    current.push(page.id);
    children.set(page.parentId, current);
  }
  const descendants = new Set<string>();
  const pending = [...(children.get(pageId) ?? [])];
  while (pending.length) {
    const childId = pending.pop();
    if (!childId || descendants.has(childId)) continue;
    descendants.add(childId);
    pending.push(...(children.get(childId) ?? []));
  }
  return descendants;
}

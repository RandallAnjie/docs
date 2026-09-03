import type { DatabaseSnapshot, PageSummary } from '@rdocs/shared';

import {
  getCollabTicket,
  getDatabase,
  getLinkedDatabase,
  getPage,
  getPageDatabase,
  listPages,
} from './api';
export const LOCAL_DOC_HYDRATE_MS = 150;

export function waitWithBudget(work: Promise<unknown>, budgetMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    work.then(
      () => finish(true),
      () => finish(false),
    );
    globalThis.setTimeout(() => finish(false), budgetMs);
  });
}

export async function loadPageDatabase(pageId: string): Promise<DatabaseSnapshot | null> {
  const owned = await getPageDatabase(pageId).catch(() => null);
  if (owned) return owned;
  const linked = await getLinkedDatabase(pageId).catch(() => ({
    databaseId: null as string | null,
  }));
  return linked.databaseId ? getDatabase(linked.databaseId).catch(() => null) : null;
}

function spaceTree(spaceId: string, page: PageSummary): Promise<PageSummary[]> {
  return listPages(spaceId).then(
    (result) =>
      result.pages.some((candidate) => candidate.id === page.id)
        ? result.pages
        : [...result.pages, page],
    () => [page],
  );
}

export function startPageOpen(
  pageId: string,
  identity: { id: string; name: string },
  options?: { renewTicket?: () => Promise<string> },
): {
  page: Promise<{ page: PageSummary }>;
  ticket: Promise<{ ticket: string }>;
  database: Promise<DatabaseSnapshot | null>;
  pages: Promise<PageSummary[]>;
} {
  const page = getPage(pageId);
  const ticket = options?.renewTicket
    ? options.renewTicket().then((value) => ({ ticket: value }))
    : getCollabTicket(pageId, identity);
  const database = loadPageDatabase(pageId);
  const pages = page.then(({ page: next }) => spaceTree(next.spaceId, next));
  return { page, ticket, database, pages };
}

export function prefetchPageOpen(pageId: string, identity: { id: string; name: string }): void {
  void getPage(pageId).catch(() => undefined);
  void getCollabTicket(pageId, identity).catch(() => undefined);
}

import type { PageSummary } from '@rdocs/shared';

const MAX_CACHE_ENTRIES = 256;
const authorizationCache = new Map<string, { checkedAt: number; page: PageSummary }>();

export function getCachedCollaborationPage(pageId: string, maxAgeMs: number): PageSummary | null {
  const cached = authorizationCache.get(pageId);
  return cached && Date.now() - cached.checkedAt < maxAgeMs ? cached.page : null;
}

export function cacheCollaborationPage(page: PageSummary): void {
  if (authorizationCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = authorizationCache.keys().next().value;
    if (oldestKey) authorizationCache.delete(oldestKey);
  }
  authorizationCache.set(page.id, { checkedAt: Date.now(), page });
}

export function invalidateCollaborationPage(pageId: string): void {
  authorizationCache.delete(pageId);
}

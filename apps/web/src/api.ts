import type {
  CollabTicketResponse,
  CreatePageResponse,
  CreateRevisionResponse,
  ListPagesResponse,
  ListRevisionsResponse,
  PageSummary,
  RestoreRevisionResponse,
} from '@rdocs/shared';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `请求失败（${response.status}）`);
  }

  return (await response.json()) as T;
}

export function createPage(
  title = '未命名页面',
  parentId: string | null = null,
): Promise<CreatePageResponse> {
  return request('/api/pages', {
    method: 'POST',
    body: JSON.stringify({ title, parentId }),
  });
}

export function listPages(): Promise<ListPagesResponse> {
  return request('/api/pages');
}

export function getPage(pageId: string): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`);
}

export function updatePageTitle(
  pageId: string,
  title: string,
  options: { keepalive?: boolean } = {},
): Promise<{ page: PageSummary }> {
  return request(`/api/pages/${encodeURIComponent(pageId)}`, {
    method: 'PATCH',
    keepalive: options.keepalive,
    body: JSON.stringify({ title }),
  });
}

export function listRevisions(pageId: string): Promise<ListRevisionsResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/revisions`);
}

export function createRevision(
  pageId: string,
  label: string,
  description = '',
): Promise<CreateRevisionResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/revisions`, {
    method: 'POST',
    body: JSON.stringify({ label, description }),
  });
}

export function restoreRevision(
  revisionId: string,
  idempotencyKey: string,
): Promise<RestoreRevisionResponse> {
  return request(`/api/revisions/${encodeURIComponent(revisionId)}/restore`, {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
  });
}

export function getCollabTicket(
  pageId: string,
  actor: { id: string; name: string },
): Promise<CollabTicketResponse> {
  return request(`/api/pages/${encodeURIComponent(pageId)}/collab-ticket`, {
    method: 'POST',
    body: JSON.stringify({ actorId: actor.id, displayName: actor.name }),
  });
}

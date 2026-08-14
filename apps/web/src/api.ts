import type {
  AuthSessionResponse,
  CollabTicketResponse,
  CreatePageResponse,
  CreateRevisionResponse,
  ListPagesResponse,
  ListRevisionsResponse,
  PageSummary,
  RestoreRevisionResponse,
} from '@rdocs/shared';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init?.headers,
    },
  });

  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('rdocs:auth-required'));
    }
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

export function getAuthSession(): Promise<AuthSessionResponse> {
  return request('/api/auth/session');
}

export function beginPasskeyRegistration(input: {
  email: string;
  displayName: string;
  enrollmentSecret: string;
}): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }> {
  return request('/api/auth/passkey/registration/options', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function finishPasskeyRegistration(
  challengeId: string,
  response: RegistrationResponseJSON,
): Promise<{ verified: true }> {
  return request('/api/auth/passkey/registration/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

export function beginPasskeyAuthentication(): Promise<{
  challengeId: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  return request('/api/auth/passkey/authentication/options', { method: 'POST' });
}

export function finishPasskeyAuthentication(
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<{ verified: true }> {
  return request('/api/auth/passkey/authentication/verify', {
    method: 'POST',
    body: JSON.stringify({ challengeId, response }),
  });
}

export function logout(): Promise<{ ok: true }> {
  return request('/api/auth/logout', { method: 'POST' });
}

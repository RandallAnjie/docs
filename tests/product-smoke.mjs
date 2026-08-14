const baseUrl = process.env.RDOCS_SMOKE_URL || 'https://docs.bigrandall.io';
const expectedOrigin = process.env.RDOCS_SMOKE_ORIGIN || 'https://docs.bigrandall.io';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}, expectedStatus = 200) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: {
      origin: expectedOrigin,
      ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const contentType = response.headers.get('content-type') ?? '';
  const body = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.arrayBuffer();
  if (response.status !== expectedStatus) {
    const details =
      body instanceof ArrayBuffer ? new TextDecoder().decode(body).slice(0, 500) : body?.error;
    throw new Error(
      `${path}: expected ${expectedStatus}, received ${response.status}; request=${response.headers.get('x-request-id') ?? 'missing'}; ${details ?? ''}`,
    );
  }
  if (path.startsWith('/api/'))
    assert(response.headers.has('x-request-id'), `${path}: no request id`);
  return { response, body };
}

let pageId = null;
let attachmentId = null;
let shareId = null;
let groupId = null;
let invitationId = null;

try {
  const session = (await request('/api/auth/session')).body;
  assert(session.mode === 'phase0', 'product smoke requires explicit phase0 mode');

  const organizations = (await request('/api/organizations')).body.organizations;
  const organization = organizations.find((candidate) => candidate.role === 'owner');
  assert(organization, 'owner organization is missing');
  const spaces = (await request(`/api/organizations/${encodeURIComponent(organization.id)}/spaces`))
    .body.spaces;
  const space = spaces.find((candidate) => candidate.role === 'space_admin');
  assert(space, 'space administrator access is missing');

  const marker = crypto.randomUUID();
  const title = `Rdocs product smoke ${marker}`;
  const created = await request(
    '/api/pages',
    {
      method: 'POST',
      body: JSON.stringify({ title, spaceId: space.id, parentId: null }),
    },
    201,
  );
  pageId = created.body.page.id;
  assert(created.body.page.organizationId === organization.id, 'page tenant mismatch');

  const search = (
    await request(
      `/api/search?organizationId=${encodeURIComponent(organization.id)}&q=${encodeURIComponent(marker)}`,
    )
  ).body.results;
  assert(
    search.some((result) => result.page.id === pageId),
    'new page was not searchable',
  );

  await request(`/api/pages/${pageId}/favorite`, { method: 'PUT' });
  const favorites = (
    await request(`/api/favorites?organizationId=${encodeURIComponent(organization.id)}`)
  ).body.pages;
  assert(
    favorites.some((favorite) => favorite.page.id === pageId),
    'favorite is missing',
  );
  await request(`/api/pages/${pageId}`);
  const recent = (
    await request(`/api/recent?organizationId=${encodeURIComponent(organization.id)}`)
  ).body.pages;
  assert(
    recent.some((visit) => visit.page.id === pageId),
    'recent visit is missing',
  );

  const access = await request(`/api/pages/${pageId}/access`, {
    method: 'PATCH',
    body: JSON.stringify({ mode: 'restricted' }),
  });
  assert(access.body.mode === 'restricted', 'restricted page mode was not saved');
  await request(`/api/pages/${pageId}/access`, {
    method: 'PATCH',
    body: JSON.stringify({ mode: 'inherit' }),
  });

  const threadResult = await request(`/api/pages/${pageId}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: `Comment ${marker}` }),
  });
  const thread = threadResult.body.threads.find((candidate) => candidate.pageId === pageId);
  assert(thread, 'comment thread is missing');
  await request(`/api/comment-threads/${thread.id}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body: 'Smoke reply' }),
  });
  const resolved = await request(`/api/comment-threads/${thread.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ resolved: true }),
  });
  assert(
    resolved.body.threads.some(
      (candidate) => candidate.id === thread.id && candidate.status === 'resolved',
    ),
    'comment thread was not resolved',
  );

  const attachmentBytes = new TextEncoder().encode(`Rdocs private attachment ${marker}`);
  const attachment = await request(
    `/api/pages/${pageId}/attachments`,
    {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-rdocs-file-name': encodeURIComponent('product-smoke.txt'),
      },
      body: attachmentBytes,
    },
    201,
  );
  attachmentId = attachment.body.attachment.id;
  const downloaded = await request(`/api/attachments/${attachmentId}`);
  assert(
    new TextDecoder().decode(downloaded.body) === `Rdocs private attachment ${marker}`,
    'private attachment content mismatch',
  );

  const share = await request(
    `/api/pages/${pageId}/share-links`,
    {
      method: 'POST',
      body: JSON.stringify({ role: 'viewer', expiresInDays: 1 }),
    },
    201,
  );
  shareId = share.body.link.id;
  const publicShare = await request(`/api/public/shares/${encodeURIComponent(share.body.token)}`);
  assert(publicShare.body.page.id === pageId, 'public share resolved the wrong page');
  const publicCookie = publicShare.response.headers.get('set-cookie');
  assert(publicCookie, 'public share did not issue an attachment cookie');
  const publicAttachment = await request(`/api/attachments/${attachmentId}`, {
    headers: { cookie: publicCookie.split(';', 1)[0] },
  });
  assert(
    publicAttachment.body.byteLength === attachmentBytes.byteLength,
    'shared attachment failed',
  );
  await request(`/api/share-links/${shareId}`, { method: 'DELETE' });
  shareId = null;
  await request(`/api/public/shares/${encodeURIComponent(share.body.token)}`, {}, 404);

  const markdown = await request(`/api/pages/${pageId}/export/markdown`, { method: 'POST' });
  assert(
    new TextDecoder().decode(markdown.body).startsWith(`# ${title}`),
    'Markdown export failed',
  );

  const group = await request(
    `/api/organizations/${organization.id}/groups`,
    {
      method: 'POST',
      body: JSON.stringify({ name: `Smoke ${marker.slice(0, 8)}` }),
    },
    201,
  );
  groupId = group.body.group.id;
  await request(`/api/organizations/${organization.id}/groups/${groupId}`, { method: 'DELETE' });
  groupId = null;

  const invitation = await request(
    `/api/organizations/${organization.id}/invitations`,
    {
      method: 'POST',
      body: JSON.stringify({ email: `smoke-${marker}@rdocs.invalid`, role: 'guest' }),
    },
    201,
  );
  invitationId = invitation.body.invitation.id;
  assert(invitation.body.token, 'invitation token is missing');
  await request(`/api/organizations/${organization.id}/invitations/${invitationId}`, {
    method: 'DELETE',
  });
  invitationId = null;

  const activity = (
    await request(`/api/organizations/${encodeURIComponent(organization.id)}/activity`)
  ).body.events;
  assert(
    activity.some((event) => event.targetId === pageId),
    'page audit activity is missing',
  );

  await request(`/api/attachments/${attachmentId}`, { method: 'DELETE' });
  attachmentId = null;
  await request(`/api/pages/${pageId}`, { method: 'DELETE' });
  const trash = (await request(`/api/spaces/${space.id}/trash`)).body.pages;
  assert(
    trash.some((page) => page.id === pageId),
    'deleted page is missing from trash',
  );
  await request(`/api/pages/${pageId}/restore`, { method: 'POST' });
  await request(`/api/pages/${pageId}`, { method: 'DELETE' });
  pageId = null;

  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        'tenant discovery',
        'page create/search/recent/favorite',
        'page access mode',
        'comments and replies',
        'private attachment',
        'expiring public share and revocation',
        'Markdown export',
        'group lifecycle',
        'invitation lifecycle',
        'audit activity',
        'trash restore',
      ],
    }),
  );
} finally {
  if (shareId) await request(`/api/share-links/${shareId}`, { method: 'DELETE' }).catch(() => {});
  if (attachmentId)
    await request(`/api/attachments/${attachmentId}`, { method: 'DELETE' }).catch(() => {});
  if (groupId) {
    const organizations = (await request('/api/organizations').catch(() => ({ body: {} }))).body
      .organizations;
    const organizationId = organizations?.find((candidate) => candidate.role === 'owner')?.id;
    if (organizationId) {
      await request(`/api/organizations/${organizationId}/groups/${groupId}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
  }
  if (invitationId) {
    const organizations = (await request('/api/organizations').catch(() => ({ body: {} }))).body
      .organizations;
    const organizationId = organizations?.find((candidate) => candidate.role === 'owner')?.id;
    if (organizationId) {
      await request(`/api/organizations/${organizationId}/invitations/${invitationId}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
  }
  if (pageId) await request(`/api/pages/${pageId}`, { method: 'DELETE' }).catch(() => {});
}

process.exit(0);

import appHtml from '../../web/dist/index.html';

import {
  EDITOR_SCHEMA_VERSION,
  isPageId,
  MAX_HTTP_SYNC_BODY_BYTES,
  MAX_REVISION_SNAPSHOT_BYTES,
  type PageSummary,
  type RevisionKind,
  type RevisionSummary,
} from '@rdocs/shared';

import { DocumentRoom } from './document-room';
import type { Env } from './env';
import { isCollaborationOriginAllowed } from './origins';
import { signCollabTicket, verifyCollabTicket } from './tickets';

export { DocumentRoom };

const SYSTEM_USER_ID = 'usr_phase0_system';
const PHASE0_ORGANIZATION_ID = 'org_phase0';
const PHASE0_SPACE_ID = 'spc_phase0';
const MAX_TITLE_LENGTH = 200;
const MAX_REVISION_LABEL_LENGTH = 100;
const MAX_REVISION_DESCRIPTION_LENGTH = 500;
const MAX_PAGE_TREE_SIZE = 500;
const MAX_REVISIONS_PER_PAGE = 100;
const MAX_GENERATION_INITIALIZATION_ATTEMPTS = 5;
const RESTORE_OPERATION_LEASE_MS = 60_000;
const COLLAB_AUTH_CACHE_MS = 2_000;

const collaborationAuthorizationCache = new Map<string, { checkedAt: number; page: PageSummary }>();

interface PageRow {
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  current_generation: number;
  editor_schema_version: number;
  updated_at: number;
  collaboration_enabled: number;
  acl_version: number;
}

interface RevisionRow {
  id: string;
  page_id: string;
  generation: number;
  collab_seq: number;
  kind: RevisionKind;
  label: string | null;
  description: string | null;
  snapshot_location: 'do' | 'r2';
  snapshot_ref: string;
  content_hash: string;
  created_by: string | null;
  created_at: number;
}

interface RestoreOperationRow {
  idempotency_key: string;
  organization_id: string;
  page_id: string;
  revision_id: string;
  source_generation: number;
  target_generation: number | null;
  previous_revision_id: string;
  status: 'pending' | 'prepared' | 'completed' | 'failed';
  lease_token: string | null;
  lease_expires_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number): Response {
  return json({ error: message }, { status });
}

function pageFromRow(row: PageRow): PageSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    currentGeneration: Number(row.current_generation),
    editorSchemaVersion: Number(row.editor_schema_version),
    updatedAt: Number(row.updated_at),
    collaborationEnabled: Boolean(row.collaboration_enabled),
    aclVersion: Number(row.acl_version),
  };
}

function revisionFromRow(row: RevisionRow): RevisionSummary {
  return {
    id: row.id,
    pageId: row.page_id,
    generation: Number(row.generation),
    collabSeq: Number(row.collab_seq),
    kind: row.kind,
    label: row.label,
    description: row.description,
    contentHash: row.content_hash,
    createdBy: row.created_by,
    createdAt: Number(row.created_at),
  };
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function documentRoom(env: Env, pageId: string, generation: number): DurableObjectStub {
  return env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${generation}`),
  );
}

async function findPage(env: Env, pageId: string): Promise<PageSummary | null> {
  const row = await env.DB.prepare(
    `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
            p.current_generation, p.editor_schema_version, p.updated_at,
            a.collaboration_enabled, a.acl_version
       FROM pages p
       JOIN page_access_state a ON a.page_id = p.id
      WHERE p.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(pageId)
    .first<PageRow>();
  return row ? pageFromRow(row) : null;
}

async function listPages(env: Env): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
            p.current_generation, p.editor_schema_version, p.updated_at,
            a.collaboration_enabled, a.acl_version
       FROM pages p
       JOIN page_access_state a ON a.page_id = p.id
      WHERE p.organization_id = ? AND p.space_id = ? AND p.deleted_at IS NULL
      ORDER BY p.sort_key ASC, p.id ASC
      LIMIT ?`,
    )
      .bind(PHASE0_ORGANIZATION_ID, PHASE0_SPACE_ID, MAX_PAGE_TREE_SIZE)
      .all<PageRow>()
  ).results;
  return json({ pages: rows.map(pageFromRow) });
}

async function captureRevision(
  env: Env,
  page: PageSummary,
  options: {
    kind: RevisionKind;
    label: string | null;
    description: string | null;
    revisionId?: string;
  },
): Promise<RevisionSummary> {
  if (options.revisionId) {
    const existing = await findRevision(env, options.revisionId);
    if (existing) return revisionFromRow(existing);
  }

  const snapshotResponse = await documentRoom(env, page.id, page.currentGeneration).fetch(
    'https://rdocs.internal/internal/export-snapshot',
    {
      method: 'POST',
      headers: { 'x-rdocs-actor-id': SYSTEM_USER_ID },
    },
  );
  if (!snapshotResponse.ok) {
    throw new Error(`revision_snapshot_export_${snapshotResponse.status}`);
  }

  const snapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
  if (snapshot.byteLength === 0 || snapshot.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
    throw new Error('revision_snapshot_size');
  }
  const collabSeq = Number(snapshotResponse.headers.get('x-rdocs-snapshot-seq') ?? -1);
  if (!Number.isSafeInteger(collabSeq) || collabSeq < 0) {
    throw new Error('revision_snapshot_seq');
  }
  const contentHash = await sha256Hex(snapshot);
  const exportedHash = snapshotResponse.headers.get('x-rdocs-content-hash');
  if (exportedHash !== contentHash) throw new Error('revision_snapshot_hash');

  const revisionId = options.revisionId ?? crypto.randomUUID();
  const snapshotRef = `organizations/${page.organizationId}/pages/${page.id}/revisions/${revisionId}.yjs`;
  const createdAt = Date.now();
  await env.ATTACHMENTS.put(snapshotRef, toArrayBuffer(snapshot), {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: {
      pageId: page.id,
      generation: String(page.currentGeneration),
      collabSeq: String(collabSeq),
      contentHash,
    },
  });

  try {
    await env.DB.prepare(
      `INSERT INTO revisions(
        id, organization_id, page_id, generation, collab_seq, kind,
        label, description, snapshot_location, snapshot_ref, content_hash,
        created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'r2', ?, ?, ?, ?)`,
    )
      .bind(
        revisionId,
        page.organizationId,
        page.id,
        page.currentGeneration,
        collabSeq,
        options.kind,
        options.label,
        options.description,
        snapshotRef,
        contentHash,
        SYSTEM_USER_ID,
        createdAt,
      )
      .run();
  } catch (reason) {
    await env.ATTACHMENTS.delete(snapshotRef).catch(() => undefined);
    throw reason;
  }

  return {
    id: revisionId,
    pageId: page.id,
    generation: page.currentGeneration,
    collabSeq,
    kind: options.kind,
    label: options.label,
    description: options.description,
    contentHash,
    createdBy: SYSTEM_USER_ID,
    createdAt,
  };
}

async function listRevisions(env: Env, pageId: string): Promise<Response> {
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);
  const rows = (
    await env.DB.prepare(
      `SELECT id, page_id, generation, collab_seq, kind, label, description,
              snapshot_location, snapshot_ref, content_hash, created_by, created_at
         FROM revisions
        WHERE organization_id = ? AND page_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(page.organizationId, page.id, MAX_REVISIONS_PER_PAGE)
      .all<RevisionRow>()
  ).results;
  return json({ revisions: rows.map(revisionFromRow) });
}

async function createRevision(request: Request, env: Env, pageId: string): Promise<Response> {
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);
  const body = (await request.json().catch(() => ({}))) as {
    label?: unknown;
    description?: unknown;
  };
  if (body.label !== undefined && typeof body.label !== 'string') {
    return error('版本名称必须是字符串', 400);
  }
  if (body.description !== undefined && typeof body.description !== 'string') {
    return error('版本说明必须是字符串', 400);
  }
  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const description = typeof body.description === 'string' ? body.description.trim() : '';
  if (label.length > MAX_REVISION_LABEL_LENGTH) return error('版本名称过长', 400);
  if (description.length > MAX_REVISION_DESCRIPTION_LENGTH) return error('版本说明过长', 400);

  const revision = await captureRevision(env, page, {
    kind: 'manual',
    label: label || null,
    description: description || null,
  });
  return json({ revision }, { status: 201 });
}

async function findRevision(env: Env, revisionId: string): Promise<RevisionRow | null> {
  return env.DB.prepare(
    `SELECT id, page_id, generation, collab_seq, kind, label, description,
            snapshot_location, snapshot_ref, content_hash, created_by, created_at
       FROM revisions
      WHERE id = ?`,
  )
    .bind(revisionId)
    .first<RevisionRow>();
}

async function findRestoreOperation(
  env: Env,
  idempotencyKey: string,
): Promise<RestoreOperationRow | null> {
  return env.DB.prepare(
    `SELECT idempotency_key, organization_id, page_id, revision_id,
            source_generation, target_generation, previous_revision_id,
            status, lease_token, lease_expires_at, created_at, updated_at, completed_at
       FROM revision_restore_operations
      WHERE idempotency_key = ?`,
  )
    .bind(idempotencyKey)
    .first<RestoreOperationRow>();
}

async function failRestoreOperation(
  env: Env,
  idempotencyKey: string,
  leaseToken: string,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE revision_restore_operations
        SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status = 'pending' AND lease_token = ?`,
  )
    .bind(Date.now(), idempotencyKey, leaseToken)
    .run();
}

async function closeSourceGeneration(env: Env, operation: RestoreOperationRow): Promise<void> {
  if (operation.target_generation === null) return;
  try {
    await documentRoom(env, operation.page_id, Number(operation.source_generation)).fetch(
      'https://rdocs.internal/internal/rebase',
      {
        method: 'POST',
        headers: { 'x-rdocs-next-generation': String(operation.target_generation) },
      },
    );
  } catch (reason) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'revision_old_generation_close_failed',
        pageId: operation.page_id,
        generation: operation.source_generation,
        message: reason instanceof Error ? reason.message : String(reason),
      }),
    );
  }
}

async function completedRestoreResponse(
  env: Env,
  operation: RestoreOperationRow,
  replay: boolean,
  context: ExecutionContext,
): Promise<Response> {
  const [page, previousRevision] = await Promise.all([
    findPage(env, operation.page_id),
    findRevision(env, operation.previous_revision_id),
  ]);
  if (!page || !previousRevision) throw new Error('revision_restore_result_missing');
  context.waitUntil(closeSourceGeneration(env, operation));
  return json(
    {
      page,
      restoredRevisionId: operation.revision_id,
      previousRevision: revisionFromRow(previousRevision),
      idempotencyKey: operation.idempotency_key,
    },
    replay ? { headers: { 'x-rdocs-idempotent-replay': '1' } } : undefined,
  );
}

async function finalizeRestoreOperation(
  env: Env,
  operation: RestoreOperationRow,
  replay: boolean,
  context: ExecutionContext,
): Promise<Response> {
  if (operation.target_generation === null) throw new Error('revision_restore_target_missing');

  let page = await findPage(env, operation.page_id);
  if (!page) return error('页面不存在', 404);
  if (page.currentGeneration === Number(operation.source_generation)) {
    await env.DB.prepare(
      `UPDATE pages
          SET current_generation = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND organization_id = ? AND current_generation = ? AND deleted_at IS NULL`,
    )
      .bind(
        operation.target_generation,
        SYSTEM_USER_ID,
        Date.now(),
        operation.page_id,
        operation.organization_id,
        operation.source_generation,
      )
      .run();
    page = await findPage(env, operation.page_id);
  }

  if (!page || page.currentGeneration !== Number(operation.target_generation)) {
    await env.DB.prepare(
      `UPDATE revision_restore_operations
          SET status = 'failed', lease_token = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status != 'completed'`,
    )
      .bind(Date.now(), operation.idempotency_key)
      .run();
    return error('页面已被其他恢复操作更新，请刷新后重试', 409);
  }

  const completedAt = Date.now();
  await env.DB.prepare(
    `UPDATE revision_restore_operations
        SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
            updated_at = ?, completed_at = ?
      WHERE idempotency_key = ? AND status IN ('prepared', 'completed')`,
  )
    .bind(completedAt, completedAt, operation.idempotency_key)
    .run();
  collaborationAuthorizationCache.delete(operation.page_id);
  const completed = await findRestoreOperation(env, operation.idempotency_key);
  if (!completed || completed.status !== 'completed') {
    throw new Error('revision_restore_completion_missing');
  }
  return completedRestoreResponse(env, completed, replay, context);
}

async function restoreRevision(
  request: Request,
  env: Env,
  revisionId: string,
  context: ExecutionContext,
): Promise<Response> {
  const idempotencyKey = request.headers.get('idempotency-key')?.trim() ?? '';
  if (!isPageId(idempotencyKey)) {
    return error('恢复版本需要有效的 Idempotency-Key', 400);
  }

  const targetRevision = await findRevision(env, revisionId);
  if (!targetRevision) return error('版本不存在', 404);
  const page = await findPage(env, targetRevision.page_id);
  if (!page) return error('页面不存在', 404);
  if (targetRevision.snapshot_location !== 'r2') {
    return error('此版本的快照位置暂不支持恢复', 409);
  }

  const now = Date.now();
  const leaseToken = crypto.randomUUID();
  const previousRevisionId = crypto.randomUUID();
  const inserted = await env.DB.prepare(
    `INSERT OR IGNORE INTO revision_restore_operations(
      idempotency_key, organization_id, page_id, revision_id, source_generation,
      target_generation, previous_revision_id, status, lease_token, lease_expires_at,
      created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'pending', ?, ?, ?, ?, NULL)`,
  )
    .bind(
      idempotencyKey,
      page.organizationId,
      page.id,
      targetRevision.id,
      page.currentGeneration,
      previousRevisionId,
      leaseToken,
      now + RESTORE_OPERATION_LEASE_MS,
      now,
      now,
    )
    .run();

  let operation = await findRestoreOperation(env, idempotencyKey);
  if (!operation) throw new Error('revision_restore_operation_missing');
  if (
    operation.organization_id !== page.organizationId ||
    operation.page_id !== page.id ||
    operation.revision_id !== targetRevision.id
  ) {
    return error('Idempotency-Key 已用于另一项恢复操作', 409);
  }
  if (operation.status === 'completed') {
    return completedRestoreResponse(env, operation, true, context);
  }
  if (operation.status === 'prepared') {
    return finalizeRestoreOperation(env, operation, true, context);
  }

  const ownsNewOperation = Boolean(inserted.meta.changes);
  if (!ownsNewOperation) {
    if (
      operation.status === 'pending' &&
      operation.lease_expires_at !== null &&
      Number(operation.lease_expires_at) > now
    ) {
      return json(
        { error: '恢复操作仍在进行，请稍后使用同一请求重试' },
        { status: 409, headers: { 'retry-after': '2' } },
      );
    }
    const claimed = await env.DB.prepare(
      `UPDATE revision_restore_operations
          SET status = 'pending', lease_token = ?, lease_expires_at = ?, updated_at = ?
        WHERE idempotency_key = ?
          AND (status = 'failed' OR (status = 'pending' AND lease_expires_at <= ?))`,
    )
      .bind(leaseToken, now + RESTORE_OPERATION_LEASE_MS, now, idempotencyKey, now)
      .run();
    if (!claimed.meta.changes) {
      return json(
        { error: '恢复操作状态已变化，请稍后使用同一请求重试' },
        { status: 409, headers: { 'retry-after': '2' } },
      );
    }
    operation = await findRestoreOperation(env, idempotencyKey);
    if (!operation) throw new Error('revision_restore_claim_missing');
  }

  try {
    const currentPage = await findPage(env, operation.page_id);
    if (!currentPage || currentPage.currentGeneration !== Number(operation.source_generation)) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('页面已被其他恢复操作更新，请刷新后重试', 409);
    }

    const snapshotObject = await env.ATTACHMENTS.get(targetRevision.snapshot_ref);
    if (!snapshotObject) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('版本快照不存在', 409);
    }
    if (snapshotObject.size > MAX_REVISION_SNAPSHOT_BYTES) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('版本快照过大', 413);
    }
    const snapshot = new Uint8Array(await snapshotObject.arrayBuffer());
    if ((await sha256Hex(snapshot)) !== targetRevision.content_hash) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('版本快照校验失败', 409);
    }

    await captureRevision(env, currentPage, {
      kind: 'restore',
      label: '恢复前自动版本',
      description: `恢复版本 ${targetRevision.id} 前自动保存`,
      revisionId: operation.previous_revision_id,
    });

    let nextGeneration: number | null = null;
    const firstCandidate = operation.target_generation ?? Number(operation.source_generation) + 1;
    for (let attempt = 0; attempt < MAX_GENERATION_INITIALIZATION_ATTEMPTS; attempt += 1) {
      const candidate = firstCandidate + attempt;
      await env.DB.prepare(
        `UPDATE revision_restore_operations
            SET target_generation = ?, lease_expires_at = ?, updated_at = ?
          WHERE idempotency_key = ? AND status = 'pending' AND lease_token = ?`,
      )
        .bind(
          candidate,
          Date.now() + RESTORE_OPERATION_LEASE_MS,
          Date.now(),
          idempotencyKey,
          leaseToken,
        )
        .run();
      const initializeResponse = await documentRoom(env, currentPage.id, candidate).fetch(
        'https://rdocs.internal/internal/initialize-generation',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'x-rdocs-page-id': currentPage.id,
            'x-rdocs-generation': String(candidate),
            'x-rdocs-revision-id': targetRevision.id,
            'x-rdocs-content-hash': targetRevision.content_hash,
            'x-rdocs-actor-id': SYSTEM_USER_ID,
          },
          body: toArrayBuffer(snapshot),
        },
      );
      if (initializeResponse.status === 409) continue;
      if (!initializeResponse.ok) {
        throw new Error(`revision_generation_initialize_${initializeResponse.status}`);
      }
      nextGeneration = candidate;
      break;
    }
    if (nextGeneration === null) {
      await failRestoreOperation(env, idempotencyKey, leaseToken);
      return error('无法分配新的文档 generation', 409);
    }

    await env.DB.prepare(
      `UPDATE revision_restore_operations
          SET target_generation = ?, status = 'prepared', lease_token = NULL,
              lease_expires_at = NULL, updated_at = ?
        WHERE idempotency_key = ? AND status = 'pending' AND lease_token = ?`,
    )
      .bind(nextGeneration, Date.now(), idempotencyKey, leaseToken)
      .run();
    const prepared = await findRestoreOperation(env, idempotencyKey);
    if (!prepared || prepared.status !== 'prepared') {
      throw new Error('revision_restore_prepare_missing');
    }
    return finalizeRestoreOperation(env, prepared, false, context);
  } catch (reason) {
    await failRestoreOperation(env, idempotencyKey, leaseToken).catch(() => undefined);
    throw reason;
  }
}

async function findPageForCollaboration(env: Env, pageId: string): Promise<PageSummary | null> {
  const cached = collaborationAuthorizationCache.get(pageId);
  if (cached && Date.now() - cached.checkedAt < COLLAB_AUTH_CACHE_MS) return cached.page;
  const page = await findPage(env, pageId);
  if (page) {
    if (collaborationAuthorizationCache.size >= 256) {
      const oldestKey = collaborationAuthorizationCache.keys().next().value;
      if (oldestKey) collaborationAuthorizationCache.delete(oldestKey);
    }
    collaborationAuthorizationCache.set(pageId, { checkedAt: Date.now(), page });
  }
  return page;
}

async function createPage(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    title?: unknown;
    parentId?: unknown;
  };
  const requestedTitle = typeof body.title === 'string' ? body.title.trim() : '';
  const title = (requestedTitle || '未命名页面').slice(0, MAX_TITLE_LENGTH);
  const parentId = body.parentId === null || body.parentId === undefined ? null : body.parentId;
  if (parentId !== null && (typeof parentId !== 'string' || !isPageId(parentId))) {
    return error('父页面 ID 无效', 400);
  }
  if (parentId !== null) {
    const parent = await findPage(env, parentId);
    if (
      !parent ||
      parent.organizationId !== PHASE0_ORGANIZATION_ID ||
      parent.spaceId !== PHASE0_SPACE_ID
    ) {
      return error('父页面不存在', 404);
    }
  }
  const id = crypto.randomUUID();
  const now = Date.now();

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO pages(
        id, organization_id, space_id, parent_id, title, sort_key,
        current_generation, editor_schema_version, created_by, updated_by,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      PHASE0_ORGANIZATION_ID,
      PHASE0_SPACE_ID,
      parentId,
      title,
      now.toString().padStart(20, '0'),
      EDITOR_SCHEMA_VERSION,
      SYSTEM_USER_ID,
      SYSTEM_USER_ID,
      now,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).bind(id, now),
  ]);

  const page = await findPage(env, id);
  return json({ page }, { status: 201 });
}

async function updatePage(request: Request, env: Env, pageId: string): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { title?: unknown };
  if (typeof body.title !== 'string') return error('title 必须是字符串', 400);
  const title = (body.title.trim() || '未命名页面').slice(0, MAX_TITLE_LENGTH);
  const result = await env.DB.prepare(
    `UPDATE pages SET title = ?, updated_by = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  )
    .bind(title, SYSTEM_USER_ID, Date.now(), pageId)
    .run();
  if (!result.meta.changes) return error('页面不存在', 404);
  return json({ page: await findPage(env, pageId) });
}

async function issueTicket(request: Request, env: Env, pageId: string): Promise<Response> {
  if (!env.COLLAB_TICKET_SECRET || env.COLLAB_TICKET_SECRET.length < 32) {
    return error('协作服务尚未配置', 503);
  }
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);
  if (!page.collaborationEnabled) return error('此页面已停止协作', 403);

  const body = (await request.json().catch(() => ({}))) as {
    actorId?: unknown;
    displayName?: unknown;
  };
  const actorId = typeof body.actorId === 'string' ? body.actorId.slice(0, 100) : '';
  const displayName =
    typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 60) : '';
  if (!actorId || !displayName) return error('协作者身份无效', 400);

  const issuedAt = Date.now();
  const expiresAt = issuedAt + 5 * 60 * 1000;
  const ticket = await signCollabTicket(
    {
      version: 1,
      pageId,
      generation: page.currentGeneration,
      actorId,
      displayName,
      role: 'editor',
      aclVersion: page.aclVersion,
      issuedAt,
      expiresAt,
    },
    env.COLLAB_TICKET_SECRET,
  );
  return json({ ticket, expiresAt, generation: page.currentGeneration });
}

async function setCollaborationAccess(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  if (
    !env.PHASE0_ADMIN_SECRET ||
    request.headers.get('authorization') !== `Bearer ${env.PHASE0_ADMIN_SECRET}`
  ) {
    return error('无权修改协作状态', 401);
  }
  const body = (await request.json().catch(() => ({}))) as { enabled?: unknown };
  if (typeof body.enabled !== 'boolean') return error('enabled 必须是布尔值', 400);
  const page = await findPage(env, pageId);
  if (!page) return error('页面不存在', 404);

  const nextVersion = page.aclVersion + 1;
  await env.DB.prepare(
    `UPDATE page_access_state
        SET collaboration_enabled = ?, acl_version = ?, updated_at = ?
      WHERE page_id = ?`,
  )
    .bind(body.enabled ? 1 : 0, nextVersion, Date.now(), pageId)
    .run();
  collaborationAuthorizationCache.delete(pageId);

  const room = env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${page.currentGeneration}`),
  );
  await room.fetch('https://rdocs.internal/internal/access', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: body.enabled, aclVersion: nextVersion }),
  });
  return json({ page: await findPage(env, pageId) });
}

async function syncCollaborationOverHttp(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && !isCollaborationOriginAllowed(request.url, origin, env.APP_ORIGIN)) {
    return error('Origin 不允许', 403);
  }

  const authorization = request.headers.get('authorization') ?? '';
  const ticketValue = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!ticketValue || !env.COLLAB_TICKET_SECRET) return error('缺少协作凭证', 401);
  const ticket = await verifyCollabTicket(ticketValue, env.COLLAB_TICKET_SECRET);
  if (!ticket || ticket.pageId !== pageId) return error('协作凭证无效或已过期', 401);

  const page = await findPageForCollaboration(env, pageId);
  if (page && page.currentGeneration !== ticket.generation) {
    return json(
      {
        error: '文档已恢复到新的 generation',
        code: 'document_rebased',
        generation: page.currentGeneration,
      },
      {
        status: 409,
        headers: { 'x-rdocs-document-generation': String(page.currentGeneration) },
      },
    );
  }
  if (!page || !page.collaborationEnabled || page.aclVersion !== ticket.aclVersion) {
    return error('页面权限已变化', 403);
  }

  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_HTTP_SYNC_BODY_BYTES) return error('同步请求过大', 413);
  const body = await request.arrayBuffer();
  if (body.byteLength > MAX_HTTP_SYNC_BODY_BYTES) return error('同步请求过大', 413);

  const room = env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${ticket.generation}`),
  );
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'x-rdocs-page-id': pageId,
    'x-rdocs-generation': String(ticket.generation),
    'x-rdocs-actor-id': ticket.actorId,
    'x-rdocs-display-name': ticket.displayName,
    'x-rdocs-role': ticket.role,
    'x-rdocs-acl-version': String(ticket.aclVersion),
    'x-rdocs-editing-enabled': '1',
  });
  const response = await room.fetch('https://rdocs.internal/internal/http-sync', {
    method: 'POST',
    headers,
    body,
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers: responseHeaders });
}

async function openCollaborationSocket(
  request: Request,
  env: Env,
  pageId: string,
): Promise<Response> {
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return error('需要 WebSocket upgrade', 426);
  }

  if (!isCollaborationOriginAllowed(request.url, request.headers.get('origin'), env.APP_ORIGIN)) {
    return error('Origin 不允许', 403);
  }

  const ticketValue = new URL(request.url).searchParams.get('ticket');
  if (!ticketValue || !env.COLLAB_TICKET_SECRET) return error('缺少协作凭证', 401);
  const ticket = await verifyCollabTicket(ticketValue, env.COLLAB_TICKET_SECRET);
  if (!ticket || ticket.pageId !== pageId) return error('协作凭证无效或已过期', 401);

  const page = await findPage(env, pageId);
  if (
    !page ||
    !page.collaborationEnabled ||
    page.currentGeneration !== ticket.generation ||
    page.aclVersion !== ticket.aclVersion
  ) {
    return error('页面权限或 generation 已变化', 403);
  }

  const room = env.DocumentRoom.get(
    env.DocumentRoom.idFromName(`document:${pageId}:generation:${ticket.generation}`),
  );
  const headers = new Headers(request.headers);
  headers.set('x-rdocs-page-id', pageId);
  headers.set('x-rdocs-generation', String(ticket.generation));
  headers.set('x-rdocs-actor-id', ticket.actorId);
  headers.set('x-rdocs-display-name', ticket.displayName);
  headers.set('x-rdocs-role', ticket.role);
  headers.set('x-rdocs-acl-version', String(ticket.aclVersion));
  headers.set('x-rdocs-editing-enabled', '1');
  return room.fetch(new Request(request, { headers }));
}

async function handleApi(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === '/api/health' && request.method === 'GET') {
    const database = await env.DB.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    return json({
      ok: database?.ok === 1,
      product: 'Rdocs',
      environment: env.ENVIRONMENT ?? 'unknown',
      release: env.RELEASE_SHA ?? 'local',
      platform: 'randallflare',
    });
  }

  if (url.pathname === '/api/pages' && request.method === 'POST') {
    return createPage(request, env);
  }

  if (url.pathname === '/api/pages' && request.method === 'GET') {
    return listPages(env);
  }

  const pageRevisionsMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/revisions$/);
  if (pageRevisionsMatch?.[1]) {
    const pageId = decodeURIComponent(pageRevisionsMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (request.method === 'GET') return listRevisions(env, pageId);
    if (request.method === 'POST') return createRevision(request, env, pageId);
  }

  const restoreRevisionMatch = url.pathname.match(/^\/api\/revisions\/([^/]+)\/restore$/);
  if (restoreRevisionMatch?.[1] && request.method === 'POST') {
    const revisionId = decodeURIComponent(restoreRevisionMatch[1]);
    return isPageId(revisionId)
      ? restoreRevision(request, env, revisionId, context)
      : error('版本 ID 无效', 400);
  }

  const pageMatch = url.pathname.match(/^\/api\/pages\/([^/]+)$/);
  if (pageMatch?.[1]) {
    const pageId = decodeURIComponent(pageMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (request.method === 'GET') {
      const page = await findPage(env, pageId);
      return page ? json({ page }) : error('页面不存在', 404);
    }
    if (request.method === 'PATCH') return updatePage(request, env, pageId);
  }

  const ticketMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collab-ticket$/);
  if (ticketMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(ticketMatch[1]);
    return isPageId(pageId) ? issueTicket(request, env, pageId) : error('页面 ID 无效', 400);
  }

  const httpSyncMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collaboration-sync$/);
  if (httpSyncMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(httpSyncMatch[1]);
    return isPageId(pageId)
      ? syncCollaborationOverHttp(request, env, pageId)
      : error('页面 ID 无效', 400);
  }

  const accessMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/collaboration-access$/);
  if (accessMatch?.[1] && request.method === 'POST') {
    const pageId = decodeURIComponent(accessMatch[1]);
    return isPageId(pageId)
      ? setCollaborationAccess(request, env, pageId)
      : error('页面 ID 无效', 400);
  }

  return error('API 路径不存在', 404);
}

function htmlResponse(): Response {
  return new Response(appHtml, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-cache',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data: blob:",
        "connect-src 'self' ws: wss:",
        "object-src 'none'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
      ].join('; '),
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/')) return handleApi(request, env, context);

      const collabMatch = url.pathname.match(/^\/collab\/([^/]+)$/);
      if (collabMatch?.[1]) {
        const pageId = decodeURIComponent(collabMatch[1]);
        return isPageId(pageId)
          ? openCollaborationSocket(request, env, pageId)
          : error('页面 ID 无效', 400);
      }

      if (request.method === 'GET' || request.method === 'HEAD') return htmlResponse();
      return error('Method not allowed', 405);
    } catch (reason) {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'request_failed',
          message: reason instanceof Error ? reason.message : String(reason),
        }),
      );
      return error('服务暂时不可用', 500);
    }
  },
};

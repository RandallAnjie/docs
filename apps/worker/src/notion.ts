import {
  resolveAutomationValue,
  type AuthUserSummary,
  type AutomationValueContext,
  type JsonValue,
  type PageSummary,
} from '@rdocs/shared';

import { findActiveMembership, requireSpaceAction } from './access';
import type { Env } from './env';
import {
  NOTION_WRITABLE_TYPES,
  notionBlocksToMarkdown,
  notionDatabaseSchema,
  notionTitle,
  notionValueToRdocs,
  planRdocsProperties,
  rdocsValueToNotion,
  type NotionBlock,
  type NotionObject,
} from './notion-convert';
import {
  cancelImportJob,
  createImportJob,
  findImportJob,
  importJobSnapshot,
  latestImportJob,
  listNotionTree,
  runImportStep,
} from './notion-import';

/**
 * Notion connector: an organization stores one internal-integration token
 * (encrypted), imports databases and pages that were shared with that
 * integration, and automations can create pages in Notion databases.
 */
let NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';
const MAX_IMPORT_ROWS = 500;
const MAX_IMPORT_BLOCKS = 1_000;
const MAX_BLOCK_DEPTH = 3;

export interface NotionDependencies {
  createMarkdownPage: (input: {
    actorId: string;
    spaceId: string;
    title: string;
    markdown: string;
    id?: string;
    parentId?: string | null;
    sortKey?: string;
    icon?: string | null;
    exactTitle?: boolean;
  }) => Promise<PageSummary | Response>;
  /** Fill a never-opened page (an imported row) with Markdown; null on success. */
  writePageContent: (input: {
    pageId: string;
    markdown: string;
    actorId: string;
  }) => Promise<Response | null>;
  databasesApi: (request: Request, env: Env, actor: AuthUserSummary) => Promise<Response | null>;
  /** Create rows; returns each new row's page id, in order. */
  bulkCreateRows: (
    env: Env,
    databaseId: string,
    actor: AuthUserSummary,
    rows: ReadonlyArray<Record<string, JsonValue>>,
  ) => Promise<string[]>;
}

export class NotionError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
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

// ── Token storage ─────────────────────────────────────────────────────────

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function tokenKey(env: Env): Promise<CryptoKey> {
  const secret = env.COLLAB_TICKET_SECRET ?? '';
  if (secret.length < 32) throw new NotionError('服务端密钥未配置，无法保存 Notion 令牌', 503);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`rdocs-notion-token:${secret}`),
  );
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encryptNotionToken(
  env: Env,
  token: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await tokenKey(env),
    new TextEncoder().encode(token),
  );
  return { ciphertext: toBase64(new Uint8Array(sealed)), iv: toBase64(iv) };
}

async function decryptNotionToken(env: Env, ciphertext: string, iv: string): Promise<string> {
  const opened = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) },
    await tokenKey(env),
    fromBase64(ciphertext),
  );
  return new TextDecoder().decode(opened);
}

export async function notionToken(env: Env, organizationId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    'SELECT token_ciphertext, token_iv FROM notion_connections WHERE organization_id = ?',
  )
    .bind(organizationId)
    .first<{ token_ciphertext: string; token_iv: string }>();
  if (!row) return null;
  try {
    return await decryptNotionToken(env, row.token_ciphertext, row.token_iv);
  } catch {
    return null;
  }
}

// ── API client ────────────────────────────────────────────────────────────

export async function notionRequest<T = NotionObject>(
  token: string,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${NOTION_API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        'notion-version': NOTION_VERSION,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return (await response.json()) as T;
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      const wait = Math.min(
        3_000,
        Number(response.headers.get('retry-after') ?? 1) * 1_000 || 1_000,
      );
      if (response.body) await response.body.cancel().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, wait));
      continue;
    }
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    if (response.status === 401) throw new NotionError('Notion 令牌无效或已被撤销', 400);
    if (response.status === 403 || response.status === 404) {
      throw new NotionError('找不到这个 Notion 内容：请在 Notion 中把它分享给这个集成', 404);
    }
    if (response.status === 400 && payload?.message) {
      throw new NotionError(`Notion 拒绝了请求：${payload.message.slice(0, 200)}`, 400);
    }
    throw new NotionError(`Notion 暂时不可用（${response.status}）`, 502);
  }
  throw new NotionError('Notion 暂时不可用', 502);
}

/** Notion ids may arrive with or without dashes, or as a URL. */
export function normalizeNotionId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let candidate = value.trim();
  // Notion links carry the page id in the path; "?v=" holds a view id instead.
  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname;
    } catch {
      return null;
    }
  }
  const matches = candidate.replace(/-/g, '').match(/[0-9a-f]{32}/gi);
  const hex = matches?.at(-1)?.toLowerCase();
  if (!hex) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function blockChildren(
  token: string,
  blockId: string,
  depth: number,
  budget: { left: number },
): Promise<NotionBlock[]> {
  const blocks: NotionBlock[] = [];
  let cursor: string | undefined;
  do {
    const page = await notionRequest<{
      results: NotionBlock[];
      has_more: boolean;
      next_cursor: string | null;
    }>(
      token,
      `/blocks/${blockId}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    for (const block of page.results) {
      if (budget.left <= 0) return blocks;
      budget.left -= 1;
      if (
        block.has_children &&
        depth < MAX_BLOCK_DEPTH &&
        block.type !== 'child_page' &&
        block.type !== 'child_database'
      ) {
        block.children = await blockChildren(token, String(block.id), depth + 1, budget);
      }
      blocks.push(block);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && budget.left > 0);
  return blocks;
}

// ── Import ────────────────────────────────────────────────────────────────

async function importNotionPage(
  env: Env,
  token: string,
  actor: AuthUserSummary,
  spaceId: string,
  notionId: string,
  deps: NotionDependencies,
): Promise<Response> {
  const page = await notionRequest(token, `/pages/${notionId}`);
  const title = notionTitle(page) || 'Notion 页面';
  const budget = { left: MAX_IMPORT_BLOCKS };
  const blocks = await blockChildren(token, notionId, 0, budget);
  const markdown = `# ${title}\n\n${notionBlocksToMarkdown(blocks)}\n`;
  const created = await deps.createMarkdownPage({ actorId: actor.id, spaceId, title, markdown });
  if (created instanceof Response) return created;
  return json({ page: created, kind: 'page', truncated: budget.left <= 0 }, { status: 201 });
}

async function importNotionDatabase(
  env: Env,
  token: string,
  actor: AuthUserSummary,
  spaceId: string,
  notionId: string,
  deps: NotionDependencies,
): Promise<Response> {
  const database = await notionRequest(token, `/databases/${notionId}`);
  const title = notionTitle(database) || 'Notion 数据库';
  const schema = notionDatabaseSchema(database);
  const plan = planRdocsProperties(schema);
  const skipped = schema
    .filter((property) => !plan.some((item) => item.notionName === property.name))
    .map((property) => property.name);
  const titlePlan = plan.find((item) => item.type === 'title');
  const page = await deps.createMarkdownPage({
    actorId: actor.id,
    spaceId,
    title,
    markdown: `# ${title}\n`,
  });
  if (page instanceof Response) return page;
  const call = async (path: string, body: unknown) => {
    const response = await deps.databasesApi(
      new Request(`https://rdocs.internal${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
      actor,
    );
    const payload = (await response?.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response?.ok)
      throw new NotionError(String(payload?.error ?? '无法创建数据库'), response?.status ?? 500);
    return payload ?? {};
  };
  const created = await call(`/api/pages/${page.id}/database`, {
    titlePropertyName: titlePlan?.name ?? '名称',
  });
  const databaseId = String((created.database as { id: string }).id);
  const propertyIds = new Map<string, string>();
  const titleProperty = (created.properties as Array<{ id: string; type: string }>).find(
    (property) => property.type === 'title',
  );
  if (titlePlan && titleProperty) propertyIds.set(titlePlan.notionName, titleProperty.id);
  for (const item of plan) {
    if (item.type === 'title') continue;
    const property = await call(`/api/databases/${databaseId}/properties`, {
      name: item.name,
      type: item.type,
      config: item.config,
    });
    propertyIds.set(item.notionName, String((property.property as { id: string }).id));
  }
  const rows: Array<Record<string, JsonValue>> = [];
  let cursor: string | undefined;
  let truncated = false;
  do {
    const result = await notionRequest<{
      results: NotionObject[];
      has_more: boolean;
      next_cursor: string | null;
    }>(token, `/databases/${notionId}/query`, {
      method: 'POST',
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    for (const entry of result.results) {
      if (rows.length >= MAX_IMPORT_ROWS) {
        truncated = true;
        break;
      }
      const values: Record<string, JsonValue> = {};
      for (const [notionName, raw] of Object.entries(
        (entry.properties ?? {}) as Record<string, unknown>,
      )) {
        const propertyId = propertyIds.get(notionName);
        if (!propertyId) continue;
        const value = notionValueToRdocs(raw);
        if (value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
        values[propertyId] = value;
      }
      rows.push(values);
    }
    cursor = !truncated && result.has_more && result.next_cursor ? result.next_cursor : undefined;
    if (result.has_more && rows.length >= MAX_IMPORT_ROWS) truncated = true;
  } while (cursor);
  const imported = (await deps.bulkCreateRows(env, databaseId, actor, rows)).length;
  return json(
    { page, kind: 'database', databaseId, imported, truncated, skippedProperties: skipped },
    { status: 201 },
  );
}

// ── HTTP routes ───────────────────────────────────────────────────────────

export async function handleNotionApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
  deps: NotionDependencies,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/organizations\/([^/]+)\/notion(?:\/(.*))?$/);
  if (!match?.[1]) return null;
  // Local testing only: point the connector at a stand-in Notion API.
  if (env.NOTION_API_BASE && env.ENVIRONMENT !== 'production') NOTION_API = env.NOTION_API_BASE;
  const organizationId = decodeURIComponent(match[1]);
  const rest = match[2] ?? '';
  const membership = await findActiveMembership(env, organizationId, actor.id);
  if (!membership || membership.role === 'guest') return error('组织不存在', 404);
  const isAdmin = membership.role === 'owner' || membership.role === 'admin';
  try {
    if (!rest) {
      if (request.method === 'GET') {
        const row = await env.DB.prepare(
          'SELECT workspace_name, bot_name, connected_at FROM notion_connections WHERE organization_id = ?',
        )
          .bind(organizationId)
          .first<{
            workspace_name: string | null;
            bot_name: string | null;
            connected_at: number;
          }>();
        return json({
          connected: Boolean(row),
          workspaceName: row?.workspace_name ?? null,
          botName: row?.bot_name ?? null,
          connectedAt: row ? Number(row.connected_at) : null,
          canManage: isAdmin,
        });
      }
      if (!isAdmin) return error('只有组织所有者或管理员可以管理 Notion 连接', 403);
      if (request.method === 'PUT') {
        const body = (await request.json().catch(() => null)) as { token?: unknown } | null;
        const token = typeof body?.token === 'string' ? body.token.trim() : '';
        if (!/^(ntn_|secret_)[A-Za-z0-9]{20,}$/.test(token)) {
          return error('请粘贴 Notion 内部集成令牌（以 ntn_ 或 secret_ 开头）', 400);
        }
        const me = await notionRequest<{ name?: string; bot?: { workspace_name?: string } }>(
          token,
          '/users/me',
        );
        const sealed = await encryptNotionToken(env, token);
        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO notion_connections(
             organization_id, token_ciphertext, token_iv, workspace_name, bot_name,
             connected_by, connected_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(organization_id) DO UPDATE SET
             token_ciphertext = excluded.token_ciphertext, token_iv = excluded.token_iv,
             workspace_name = excluded.workspace_name, bot_name = excluded.bot_name,
             connected_by = excluded.connected_by, updated_at = excluded.updated_at`,
        )
          .bind(
            organizationId,
            sealed.ciphertext,
            sealed.iv,
            me.bot?.workspace_name ?? null,
            me.name ?? null,
            actor.id,
            now,
            now,
          )
          .run();
        return json({
          connected: true,
          workspaceName: me.bot?.workspace_name ?? null,
          botName: me.name ?? null,
          connectedAt: now,
          canManage: true,
        });
      }
      if (request.method === 'DELETE') {
        await env.DB.prepare('DELETE FROM notion_connections WHERE organization_id = ?')
          .bind(organizationId)
          .run();
        return json({ connected: false, canManage: true });
      }
      return error('请求方法不支持', 405);
    }

    const token = await notionToken(env, organizationId);
    if (!token) return error('还没有连接 Notion', 409);

    if (rest === 'search' && request.method === 'GET') {
      const kind = url.searchParams.get('kind') === 'page' ? 'page' : 'database';
      const result = await notionRequest<{ results: NotionObject[] }>(token, '/search', {
        method: 'POST',
        body: {
          query: (url.searchParams.get('q') ?? '').slice(0, 100),
          filter: { property: 'object', value: kind },
          page_size: 50,
        },
      });
      return json({
        results: result.results.map((item) => ({
          id: String(item.id),
          kind,
          title: notionTitle(item) || (kind === 'page' ? '未命名页面' : '未命名数据库'),
          url: typeof item.url === 'string' ? item.url : null,
          icon:
            item.icon && typeof item.icon === 'object' && (item.icon as { emoji?: string }).emoji
              ? (item.icon as { emoji: string }).emoji
              : null,
        })),
      });
    }

    if (rest === 'tree' && request.method === 'GET') {
      return json({ roots: await listNotionTree(token) });
    }

    if (rest === 'import-jobs' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const spaceId = typeof body?.spaceId === 'string' ? body.spaceId : '';
      if (!spaceId || spaceId.length > 100) return error('请选择导入到哪个空间', 400);
      const space = await requireSpaceAction(env, spaceId, actor.id, 'create_child');
      if (!space || space.organizationId !== organizationId)
        return error('空间不存在或无权导入', 404);
      const roots = (Array.isArray(body?.roots) ? body.roots : [])
        .slice(0, 500)
        .flatMap((value) => {
          const entry =
            value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
          const id = normalizeNotionId(entry.id);
          const kind =
            entry.kind === 'database' ? 'database' : entry.kind === 'page' ? 'page' : null;
          if (!id || !kind) return [];
          const title = typeof entry.title === 'string' ? entry.title : '';
          return [{ id, kind, title } as const];
        });
      if (!roots.length) return error('请至少选择一个要导入的页面或数据库', 400);
      const running = await latestImportJob(env, organizationId);
      if (running?.status === 'running') {
        return error('已有导入正在进行，请等它完成或先取消', 409);
      }
      const jobId = await createImportJob(env, {
        organizationId,
        spaceId,
        actorId: actor.id,
        roots,
      });
      const job = await findImportJob(env, jobId);
      return json({ job: job ? await importJobSnapshot(env, job) : null }, { status: 201 });
    }

    if (rest === 'import-jobs/latest' && request.method === 'GET') {
      const job = await latestImportJob(env, organizationId);
      return json({ job: job ? await importJobSnapshot(env, job) : null });
    }

    const jobMatch = rest.match(/^import-jobs\/([^/]+)\/(step|cancel)$/);
    if (jobMatch?.[1] && request.method === 'POST') {
      const job = await findImportJob(env, decodeURIComponent(jobMatch[1]));
      if (!job || job.organization_id !== organizationId) return error('导入任务不存在', 404);
      if (job.created_by !== actor.id && !isAdmin) return error('只有发起导入的人可以继续', 403);
      if (jobMatch[2] === 'cancel') await cancelImportJob(env, job);
      else await runImportStep(env, token, job, actor, deps);
      const fresh = await findImportJob(env, job.id);
      return json({ job: fresh ? await importJobSnapshot(env, fresh) : null });
    }

    const schemaMatch = rest.match(/^databases\/([^/]+)$/);
    if (schemaMatch?.[1] && request.method === 'GET') {
      const id = normalizeNotionId(decodeURIComponent(schemaMatch[1]));
      if (!id) return error('Notion 数据库 ID 无效', 400);
      const database = await notionRequest(token, `/databases/${id}`);
      return json({
        id,
        title: notionTitle(database),
        properties: notionDatabaseSchema(database).map((property) => ({
          ...property,
          writable: NOTION_WRITABLE_TYPES.has(property.type),
        })),
      });
    }

    if (rest === 'import' && request.method === 'POST') {
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
      const notionId = normalizeNotionId(body?.notionId);
      const spaceId = typeof body?.spaceId === 'string' ? body.spaceId : '';
      if (!notionId) return error('请选择要导入的 Notion 页面或数据库', 400);
      if (!spaceId || spaceId.length > 100) return error('请选择导入到哪个空间', 400);
      const space = await requireSpaceAction(env, spaceId, actor.id, 'create_child');
      if (!space || space.organizationId !== organizationId)
        return error('空间不存在或无权导入', 404);
      return body?.kind === 'page'
        ? importNotionPage(env, token, actor, spaceId, notionId, deps)
        : importNotionDatabase(env, token, actor, spaceId, notionId, deps);
    }
    return error('Notion 接口不存在', 404);
  } catch (reason) {
    if (reason instanceof NotionError) return error(reason.message, reason.status);
    throw reason;
  }
}

// ── Automation action ────────────────────────────────────────────────────

interface NotionMapping {
  name: string;
  type: string;
  value: JsonValue;
}

function mappings(config: Record<string, JsonValue>): NotionMapping[] {
  return (Array.isArray(config.properties) ? config.properties : []).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const { name, type, value } = item as Record<string, JsonValue>;
    return typeof name === 'string' && typeof type === 'string'
      ? [{ name, type, value: value ?? null }]
      : [];
  });
}

export async function validateNotionCreatePage(
  env: Env,
  organizationId: string,
  config: Record<string, JsonValue>,
): Promise<string | null> {
  const token = await notionToken(env, organizationId);
  if (!token) return '还没有连接 Notion';
  const databaseId = normalizeNotionId(config.notionDatabaseId);
  if (!databaseId) return '请选择 Notion 数据库';
  const items = mappings(config);
  if (!items.length) return '请至少设置一个 Notion 字段';
  try {
    const schema = notionDatabaseSchema(await notionRequest(token, `/databases/${databaseId}`));
    for (const item of items) {
      const property = schema.find((candidate) => candidate.name === item.name);
      if (!property) return `Notion 字段「${item.name}」不存在`;
      if (!NOTION_WRITABLE_TYPES.has(property.type)) return `Notion 字段「${item.name}」不能写入`;
      if (property.type !== item.type) return `Notion 字段「${item.name}」的类型已变化，请重新选择`;
    }
  } catch (reason) {
    return reason instanceof Error ? reason.message : '无法读取 Notion 数据库';
  }
  return null;
}

export async function runNotionCreatePage(
  env: Env,
  input: {
    organizationId: string;
    config: Record<string, JsonValue>;
    values: AutomationValueContext;
  },
): Promise<number | null> {
  const token = await notionToken(env, input.organizationId);
  if (!token) throw new Error('Notion 连接已断开');
  const databaseId = normalizeNotionId(input.config.notionDatabaseId);
  if (!databaseId) throw new Error('Notion 数据库无效');
  const properties: Record<string, unknown> = {};
  for (const item of mappings(input.config)) {
    const payload = rdocsValueToNotion(item.type, resolveAutomationValue(item.value, input.values));
    if (payload !== undefined) properties[item.name] = payload;
  }
  await notionRequest(token, '/pages', {
    method: 'POST',
    body: { parent: { database_id: databaseId }, properties },
  });
  return 200;
}

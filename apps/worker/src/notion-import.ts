import type { AuthUserSummary, JsonValue } from '@rdocs/shared';

import type { Env } from './env';
import { activeUser } from './databases';
import {
  blockChildren,
  isTransientNotionError,
  NotionError,
  notionRequest,
  notionToken,
  type NotionDependencies,
} from './notion';
import {
  notionBlocksToMarkdown,
  notionChildEntries,
  notionDatabaseSchema,
  notionHostedFiles,
  notionTitle,
  notionValueToRdocs,
  planRdocsProperties,
  type NotionBlock,
  type NotionObject,
} from './notion-convert';

/**
 * Importing a whole Notion tree: one job, and a queue of items processed a
 * few at a time (each request does ~20 s of work), so large workspaces never
 * hit request limits and an interrupted import can continue.
 *
 *   page      → an Rdocs page; its sub-pages and databases are queued under it
 *   database  → an Rdocs database with the same fields; queues its rows
 *   rows      → one batch of rows (Notion pages) from a database query
 *   row       → a row's own body, written into the row's Rdocs page
 */
export type ImportItemKind = 'page' | 'database' | 'rows' | 'row';

const STEP_BUDGET_MS = 20_000;
const STALE_WORK_MS = 2 * 60_000;
const ROW_BATCH = 50;
const MAX_ROWS_PER_DATABASE = 5_000;
const MAX_BLOCKS_PER_PAGE = 1_000;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FILES_PER_PAGE = 60;
const MAX_TREE_ITEMS = 3_000;
/** Rate limits and outages: try again later, up to this many times. */
const MAX_ATTEMPTS = 8;

/** Wait before retrying an item: what Notion asked for, at least 2 s × 2^attempts (≤ 2 min). */
export function retryDelayMs(attempts: number, retryAfterMs: number | null): number {
  const backoff = Math.min(120_000, 2_000 * 2 ** Math.max(0, attempts));
  return Math.max(backoff, retryAfterMs ?? 0);
}

export interface ImportJobRow {
  id: string;
  organization_id: string;
  space_id: string;
  status: 'running' | 'completed' | 'cancelled';
  total: number;
  done: number;
  failed: number;
  next_seq: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

interface ImportItemRow {
  id: string;
  job_id: string;
  notion_id: string;
  kind: ImportItemKind;
  title: string | null;
  parent_page_id: string | null;
  page_id: string;
  seq: number;
  state_json: string | null;
  status: string;
  attempts: number;
  retry_at: number | null;
}

export interface NotionTreeEntry {
  id: string;
  kind: 'page' | 'database';
  title: string;
  icon: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function emojiIcon(object: NotionObject): string | null {
  const icon = record(object.icon);
  return typeof icon.emoji === 'string' ? icon.emoji : null;
}

/** Sort key that keeps Notion's order among siblings created by one job. */
export function importSortKey(jobCreatedAt: number, seq: number): string {
  return `${String(jobCreatedAt).padStart(13, '0')}${String(seq).padStart(7, '0')}`;
}

interface SearchEntry {
  id: string;
  object: 'page' | 'database';
  parent: { type: string; id: string | null };
  title: string;
  icon: string | null;
}

/**
 * The top of what the integration can see: entries whose parent is the
 * workspace, or whose parent was not shared with the integration. Rows of
 * shared databases and sub-pages of shared pages come along with them.
 */
export function notionRoots(entries: readonly SearchEntry[]): SearchEntry[] {
  const visible = new Set(entries.map((entry) => entry.id));
  return entries.filter(
    (entry) =>
      // Rows always come with their database (search lists every row).
      entry.parent.type !== 'database_id' &&
      (entry.parent.type === 'workspace' || !entry.parent.id || !visible.has(entry.parent.id)),
  );
}

function searchEntry(object: NotionObject): SearchEntry | null {
  const kind = object.object === 'database' ? 'database' : object.object === 'page' ? 'page' : null;
  if (!kind || object.archived === true || object.in_trash === true) return null;
  const parent = record(object.parent);
  const type = typeof parent.type === 'string' ? parent.type : 'workspace';
  const id =
    typeof parent.page_id === 'string'
      ? parent.page_id
      : typeof parent.database_id === 'string'
        ? parent.database_id
        : typeof parent.block_id === 'string'
          ? parent.block_id
          : null;
  return {
    id: String(object.id),
    object: kind,
    parent: { type, id },
    title: notionTitle(object) || (kind === 'page' ? '未命名页面' : '未命名数据库'),
    icon: emojiIcon(object),
  };
}

/** Everything shared with the integration, reduced to the top-level entries. */
export async function listNotionTree(token: string): Promise<NotionTreeEntry[]> {
  const entries: SearchEntry[] = [];
  let cursor: string | undefined;
  do {
    const page = await notionRequest<{
      results: NotionObject[];
      has_more: boolean;
      next_cursor: string | null;
    }>(token, '/search', {
      method: 'POST',
      body: { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) },
    });
    for (const result of page.results) {
      const entry = searchEntry(result);
      if (entry) entries.push(entry);
    }
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor && entries.length < MAX_TREE_ITEMS);

  // A page inside a column or toggle has a block as its parent: find the
  // page that block belongs to (a few hops at most).
  const visible = new Set(entries.map((entry) => entry.id));
  for (const entry of entries) {
    let hops = 0;
    while (entry.parent.type === 'block_id' && entry.parent.id && hops < 5) {
      hops += 1;
      const block = await notionRequest(token, `/blocks/${entry.parent.id}`).catch(() => null);
      const parent = record(block?.parent);
      const type = typeof parent.type === 'string' ? parent.type : 'workspace';
      const id =
        typeof parent.page_id === 'string'
          ? parent.page_id
          : typeof parent.block_id === 'string'
            ? parent.block_id
            : typeof parent.database_id === 'string'
              ? parent.database_id
              : null;
      entry.parent = { type: block ? type : 'workspace', id: block ? id : null };
      if (id && visible.has(id)) break;
    }
  }
  return notionRoots(entries).map((entry) => ({
    id: entry.id,
    kind: entry.object,
    title: entry.title,
    icon: entry.icon,
  }));
}

// ── Jobs ──────────────────────────────────────────────────────────────────

export async function createImportJob(
  env: Env,
  input: {
    organizationId: string;
    spaceId: string;
    actorId: string;
    roots: ReadonlyArray<{ id: string; kind: 'page' | 'database'; title: string }>;
  },
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      `INSERT INTO notion_import_jobs(
         id, organization_id, space_id, status, total, done, failed, next_seq,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, 'running', ?, 0, 0, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.organizationId,
      input.spaceId,
      input.roots.length,
      input.roots.length,
      input.actorId,
      now,
      now,
    ),
    ...input.roots.map((root, index) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO notion_import_items(
           id, job_id, notion_id, kind, title, parent_page_id, page_id, seq, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'pending', ?)`,
      ).bind(
        crypto.randomUUID(),
        id,
        root.id,
        root.kind,
        root.title.slice(0, 300),
        crypto.randomUUID(),
        index,
        now,
      ),
    ),
  ];
  await env.DB.batch(statements);
  return id;
}

export async function findImportJob(env: Env, jobId: string): Promise<ImportJobRow | null> {
  return env.DB.prepare('SELECT * FROM notion_import_jobs WHERE id = ?')
    .bind(jobId)
    .first<ImportJobRow>();
}

export async function latestImportJob(
  env: Env,
  organizationId: string,
): Promise<ImportJobRow | null> {
  return env.DB.prepare(
    `SELECT * FROM notion_import_jobs WHERE organization_id = ?
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(organizationId)
    .first<ImportJobRow>();
}

export async function importJobSnapshot(env: Env, job: ImportJobRow) {
  const [failures, roots, working, waiting] = await Promise.all([
    env.DB.prepare(
      `SELECT kind, title, error_message FROM notion_import_items
        WHERE job_id = ? AND status = 'failed' ORDER BY seq DESC LIMIT 30`,
    )
      .bind(job.id)
      .all<{ kind: string; title: string | null; error_message: string | null }>(),
    env.DB.prepare(
      `SELECT kind, title, page_id FROM notion_import_items
        WHERE job_id = ? AND parent_page_id IS NULL AND kind IN ('page', 'database')
          AND status = 'done' ORDER BY seq LIMIT 50`,
    )
      .bind(job.id)
      .all<{ kind: string; title: string | null; page_id: string }>(),
    env.DB.prepare(
      `SELECT title FROM notion_import_items
        WHERE job_id = ? AND status = 'working' ORDER BY seq LIMIT 1`,
    )
      .bind(job.id)
      .first<{ title: string | null }>(),
    env.DB.prepare(
      `SELECT MIN(retry_at) AS next_retry,
              SUM(CASE WHEN retry_at IS NULL OR retry_at <= ? THEN 1 ELSE 0 END) AS ready,
              SUM(CASE WHEN retry_at > ? THEN 1 ELSE 0 END) AS delayed
         FROM notion_import_items WHERE job_id = ? AND status = 'pending'`,
    )
      .bind(Date.now(), Date.now(), job.id)
      .first<{ next_retry: number | null; ready: number | null; delayed: number | null }>(),
  ]);
  const delayed = Number(waiting?.delayed ?? 0);
  const retryInMs =
    job.status === 'running' && !Number(waiting?.ready ?? 0) && delayed && waiting?.next_retry
      ? Math.max(0, Number(waiting.next_retry) - Date.now())
      : 0;
  return {
    id: job.id,
    status: job.status,
    spaceId: job.space_id,
    total: Number(job.total),
    done: Number(job.done),
    failed: Number(job.failed),
    createdAt: Number(job.created_at),
    finishedAt: job.finished_at === null ? null : Number(job.finished_at),
    current: working?.title ?? null,
    /** Items waiting out a Notion rate limit, and how long until the next one. */
    delayed,
    retryInMs,
    failures: failures.results.map((item) => ({
      kind: item.kind,
      title: item.title ?? '未命名',
      error: item.error_message ?? '导入失败',
    })),
    imported: roots.results.map((item) => ({
      kind: item.kind,
      title: item.title ?? '未命名',
      pageId: item.page_id,
    })),
  };
}

/** Put failed items back in the queue (for example after a long Notion outage). */
export async function retryFailedImportItems(env: Env, job: ImportJobRow): Promise<void> {
  const now = Date.now();
  const reset = await env.DB.prepare(
    `UPDATE notion_import_items
        SET status = 'pending', attempts = 0, retry_at = NULL, error_message = NULL, updated_at = ?
      WHERE job_id = ? AND status = 'failed'`,
  )
    .bind(now, job.id)
    .run();
  const count = Number(reset.meta.changes ?? 0);
  if (!count) return;
  await env.DB.prepare(
    `UPDATE notion_import_jobs
        SET failed = MAX(0, failed - ?), status = 'running', finished_at = NULL, updated_at = ?
      WHERE id = ?`,
  )
    .bind(count, now, job.id)
    .run();
}

export async function cancelImportJob(env: Env, job: ImportJobRow): Promise<void> {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE notion_import_items SET status = 'skipped', updated_at = ?
        WHERE job_id = ? AND status IN ('pending', 'working')`,
    ).bind(now, job.id),
    env.DB.prepare(
      `UPDATE notion_import_jobs SET status = 'cancelled', updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    ).bind(now, now, job.id),
  ]);
}

// ── Processing ────────────────────────────────────────────────────────────

interface StepContext {
  env: Env;
  token: string;
  actor: AuthUserSummary;
  deps: NotionDependencies;
  job: ImportJobRow;
}

async function claimNext(env: Env, jobId: string): Promise<ImportItemRow | null> {
  return env.DB.prepare(
    `UPDATE notion_import_items SET status = 'working', updated_at = ?
      WHERE id = (
        SELECT id FROM notion_import_items
         WHERE job_id = ? AND status = 'pending' AND (retry_at IS NULL OR retry_at <= ?)
         ORDER BY seq LIMIT 1
      ) AND status = 'pending'
      RETURNING *`,
  )
    .bind(Date.now(), jobId, Date.now())
    .first<ImportItemRow>();
}

/** Queue items; an item already queued keeps its page (and gains a parent if it had none). */
async function enqueue(
  context: StepContext,
  items: ReadonlyArray<{
    notionId: string;
    kind: ImportItemKind;
    title: string;
    parentPageId: string | null;
    pageId?: string;
    state?: unknown;
  }>,
): Promise<Map<string, string>> {
  const { env, job } = context;
  const pageIds = new Map<string, string>();
  if (!items.length) return pageIds;
  const fresh = await env.DB.prepare('SELECT next_seq FROM notion_import_jobs WHERE id = ?')
    .bind(job.id)
    .first<{ next_seq: number }>();
  let seq = Number(fresh?.next_seq ?? job.next_seq);
  const now = Date.now();
  const inserts = items.map((item) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO notion_import_items(
         id, job_id, notion_id, kind, title, parent_page_id, page_id, seq, state_json,
         status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    ).bind(
      crypto.randomUUID(),
      job.id,
      item.notionId,
      item.kind,
      item.title.slice(0, 300),
      item.parentPageId,
      item.pageId ?? crypto.randomUUID(),
      seq++,
      item.state === undefined ? null : JSON.stringify(item.state),
      now,
    ),
  );
  const results = await env.DB.batch(inserts);
  const added = results.reduce((sum, result) => sum + Number(result.meta.changes ?? 0), 0);
  // Something queued earlier as a top-level item belongs under this parent.
  const adopt = items
    .filter((item) => item.parentPageId)
    .map((item) =>
      env.DB.prepare(
        `UPDATE notion_import_items SET parent_page_id = ?
          WHERE job_id = ? AND kind = ? AND notion_id = ? AND parent_page_id IS NULL
            AND status = 'pending'`,
      ).bind(item.parentPageId, job.id, item.kind, item.notionId),
    );
  if (adopt.length) await env.DB.batch(adopt);
  await env.DB.prepare(
    `UPDATE notion_import_jobs SET next_seq = ?, total = total + ?, updated_at = ? WHERE id = ?`,
  )
    .bind(seq, added, now, job.id)
    .run();
  // Items given their own page id keep it; look up the rest (an item queued
  // earlier keeps the page it was given then). D1 binds at most 100 values.
  for (const item of items)
    if (item.pageId) pageIds.set(`${item.kind}:${item.notionId}`, item.pageId);
  const lookup = items.filter((item) => !item.pageId);
  for (let start = 0; start < lookup.length; start += 40) {
    const chunk = lookup.slice(start, start + 40);
    const rows = await env.DB.prepare(
      `SELECT kind, notion_id, page_id FROM notion_import_items
        WHERE job_id = ? AND notion_id IN (${chunk.map(() => '?').join(', ')})`,
    )
      .bind(job.id, ...chunk.map((item) => item.notionId))
      .all<{ kind: string; notion_id: string; page_id: string }>();
    for (const row of rows.results) pageIds.set(`${row.kind}:${row.notion_id}`, row.page_id);
  }
  return pageIds;
}

function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/\u0000-\u001f]/g, '_').trim();
  return (cleaned || '附件').slice(0, 200);
}

interface CopiedFile {
  id: string;
  r2Key: string;
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Copy Notion-hosted files (their links expire) into this page's attachments storage. */
async function copyHostedFiles(
  context: StepContext,
  pageId: string,
  blocks: readonly NotionBlock[],
): Promise<{ links: Map<string, { attachmentId: string; name: string }>; copied: CopiedFile[] }> {
  const links = new Map<string, { attachmentId: string; name: string }>();
  const copied: CopiedFile[] = [];
  for (const file of notionHostedFiles(blocks).slice(0, MAX_FILES_PER_PAGE)) {
    if (links.has(file.url)) continue;
    try {
      const response = await fetch(file.url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) continue;
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_FILE_BYTES) {
        await response.body?.cancel().catch(() => undefined);
        continue;
      }
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_FILE_BYTES) continue;
      const id = crypto.randomUUID();
      const name = safeFileName(file.name);
      const mimeType =
        (response.headers.get('content-type') ?? '').split(';')[0]?.trim() ||
        'application/octet-stream';
      const r2Key = `organizations/${context.job.organization_id}/pages/${pageId}/attachments/${id}`;
      const digest = await sha256Hex(bytes);
      await context.env.ATTACHMENTS.put(r2Key, bytes, {
        httpMetadata: { contentType: mimeType },
        customMetadata: { pageId, originalName: name, sha256: digest },
      });
      copied.push({ id, r2Key, name, mimeType, size: bytes.byteLength, sha256: digest });
      links.set(file.url, { attachmentId: id, name });
    } catch {
      // Leave the original link in place; the rest of the page still imports.
    }
  }
  return { links, copied };
}

async function recordAttachments(
  context: StepContext,
  pageId: string,
  files: readonly CopiedFile[],
): Promise<void> {
  if (!files.length) return;
  const now = Date.now();
  await context.env.DB.batch(
    files.map((file) =>
      context.env.DB.prepare(
        `INSERT INTO attachments(
           id, organization_id, page_id, r2_key, original_name, mime_type,
           byte_size, sha256, status, created_by, created_at, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL)`,
      ).bind(
        file.id,
        context.job.organization_id,
        pageId,
        file.r2Key,
        file.name,
        file.mimeType,
        file.size,
        file.sha256,
        context.actor.id,
        now,
      ),
    ),
  );
}

/** Body Markdown for a Notion page, with its children queued under `pageId`. */
async function bodyMarkdown(
  context: StepContext,
  notionPageId: string,
  pageId: string,
): Promise<{ markdown: string; files: CopiedFile[] }> {
  const budget = { left: MAX_BLOCKS_PER_PAGE };
  const blocks = await blockChildren(context.token, notionPageId, 0, budget);
  const children = notionChildEntries(blocks);
  const queued = await enqueue(
    context,
    children.map((child) => ({
      notionId: child.id,
      kind: child.kind,
      title: child.title,
      parentPageId: pageId,
    })),
  );
  const childPages = new Map<string, { pageId: string; title: string }>();
  for (const child of children) {
    const target = queued.get(`${child.kind}:${child.id}`);
    if (target) childPages.set(child.id, { pageId: target, title: child.title });
  }
  const { links, copied } = await copyHostedFiles(context, pageId, blocks);
  const markdown = notionBlocksToMarkdown(blocks, 0, { childPages, files: links });
  return {
    markdown:
      budget.left <= 0
        ? `${markdown}\n\n> 内容较长，只导入了前 ${MAX_BLOCKS_PER_PAGE} 个块。`
        : markdown,
    files: copied,
  };
}

async function processPage(context: StepContext, item: ImportItemRow): Promise<void> {
  const page = await notionRequest(context.token, `/pages/${item.notion_id}`);
  if (page.archived === true || page.in_trash === true) return;
  const title = notionTitle(page) || item.title || '未命名页面';
  const { markdown, files } = await bodyMarkdown(context, item.notion_id, item.page_id);
  if (await pageExists(context, item.page_id)) {
    // A retry over the placeholder an earlier attempt left: put the content in.
    const failed = await context.deps.replacePageContent({
      pageId: item.page_id,
      markdown,
      title,
      icon: emojiIcon(page),
      actorId: context.actor.id,
    });
    if (failed) throw new NotionError(await responseError(failed), 400);
  } else {
    const created = await context.deps.createMarkdownPage({
      actorId: context.actor.id,
      spaceId: context.job.space_id,
      title,
      markdown,
      id: item.page_id,
      parentId: item.parent_page_id,
      sortKey: importSortKey(Number(context.job.created_at), Number(item.seq)),
      icon: emojiIcon(page),
      exactTitle: true,
    });
    if (created instanceof Response) throw new NotionError(await responseError(created), 400);
  }
  await recordAttachments(context, item.page_id, files);
}

async function pageExists(context: StepContext, pageId: string): Promise<boolean> {
  return Boolean(
    await context.env.DB.prepare('SELECT 1 AS found FROM pages WHERE id = ?')
      .bind(pageId)
      .first<{ found: number }>(),
  );
}

async function responseError(response: Response): Promise<string> {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return payload?.error ?? `失败（${response.status}）`;
}

async function databaseCall(
  context: StepContext,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await context.deps.databasesApi(
    new Request(`https://rdocs.internal${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    context.env,
    context.actor,
  );
  const payload = (await response?.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response?.ok) {
    throw new NotionError(String(payload?.error ?? '无法创建数据库'), response?.status ?? 500);
  }
  return payload ?? {};
}

interface RowsState {
  databaseId: string;
  propertyIds: Record<string, string>;
  cursor: string | null;
  imported: number;
}

async function processDatabase(context: StepContext, item: ImportItemRow): Promise<void> {
  let database: NotionObject;
  try {
    database = await notionRequest(context.token, `/databases/${item.notion_id}`);
  } catch (reason) {
    if (reason instanceof NotionError && reason.status === 404) {
      throw new NotionError('这是其他数据库的关联视图，请把源数据库也连接到集成', 404);
    }
    throw reason;
  }
  const title = notionTitle(database) || item.title || '未命名数据库';
  const plan = planRdocsProperties(notionDatabaseSchema(database));
  const titlePlan = plan.find((entry) => entry.type === 'title');
  if (!(await pageExists(context, item.page_id))) {
    const created = await context.deps.createMarkdownPage({
      actorId: context.actor.id,
      spaceId: context.job.space_id,
      title,
      markdown: '',
      id: item.page_id,
      parentId: item.parent_page_id,
      sortKey: importSortKey(Number(context.job.created_at), Number(item.seq)),
      icon: emojiIcon(database),
      exactTitle: true,
    });
    if (created instanceof Response) throw new NotionError(await responseError(created), 400);
  }
  const snapshot = await databaseCall(context, `/api/pages/${item.page_id}/database`, {
    titlePropertyName: titlePlan?.name ?? '名称',
  });
  const databaseId = String((snapshot.database as { id: string }).id);
  const propertyIds: Record<string, string> = {};
  const titleProperty = (snapshot.properties as Array<{ id: string; type: string }>).find(
    (property) => property.type === 'title',
  );
  if (titlePlan && titleProperty) propertyIds[titlePlan.notionName] = titleProperty.id;
  for (const entry of plan) {
    if (entry.type === 'title') continue;
    const property = await databaseCall(context, `/api/databases/${databaseId}/properties`, {
      name: entry.name,
      type: entry.type,
      config: entry.config,
    });
    propertyIds[entry.notionName] = String((property.property as { id: string }).id);
  }
  const state: RowsState = { databaseId, propertyIds, cursor: null, imported: 0 };
  await enqueue(context, [
    {
      notionId: `${item.notion_id}:start`,
      kind: 'rows',
      title: `${title} 的记录`,
      parentPageId: item.page_id,
      state,
    },
  ]);
}

async function processRows(context: StepContext, item: ImportItemRow): Promise<void> {
  const state = JSON.parse(item.state_json ?? '{}') as RowsState;
  const notionDatabaseId = item.notion_id.split(':')[0]!;
  const result = await notionRequest<{
    results: NotionObject[];
    has_more: boolean;
    next_cursor: string | null;
  }>(context.token, `/databases/${notionDatabaseId}/query`, {
    method: 'POST',
    body: { page_size: ROW_BATCH, ...(state.cursor ? { start_cursor: state.cursor } : {}) },
  });
  const entries = result.results.filter((entry) => entry.archived !== true);
  const values = entries.map((entry) => {
    const row: Record<string, JsonValue> = {};
    for (const [notionName, raw] of Object.entries(record(entry.properties))) {
      const propertyId = state.propertyIds[notionName];
      if (!propertyId) continue;
      const value = notionValueToRdocs(raw);
      if (value === null || value === '' || (Array.isArray(value) && !value.length)) continue;
      row[propertyId] = value;
    }
    return row;
  });
  const pageIds = await context.deps.bulkCreateRows(
    context.env,
    state.databaseId,
    context.actor,
    values,
  );
  const imported = state.imported + pageIds.length;
  const next =
    result.has_more && result.next_cursor && imported < MAX_ROWS_PER_DATABASE
      ? [
          {
            notionId: `${notionDatabaseId}:${result.next_cursor}`,
            kind: 'rows' as const,
            title: item.title ?? '记录',
            parentPageId: item.parent_page_id,
            state: { ...state, cursor: result.next_cursor, imported },
          },
        ]
      : [];
  await enqueue(context, [
    ...entries.map((entry, index) => ({
      notionId: String(entry.id),
      kind: 'row' as const,
      title: notionTitle(entry) || '未命名',
      parentPageId: item.parent_page_id,
      pageId: pageIds[index]!,
    })),
    ...next,
  ]);
}

async function processRow(context: StepContext, item: ImportItemRow): Promise<void> {
  const { markdown, files } = await bodyMarkdown(context, item.notion_id, item.page_id);
  if (!markdown.trim()) return;
  const failed = await context.deps.writePageContent({
    pageId: item.page_id,
    markdown,
    actorId: context.actor.id,
  });
  if (failed && failed.status !== 409) throw new NotionError(await responseError(failed), 400);
  await recordAttachments(context, item.page_id, files);
}

/**
 * A page or database that could not be imported still gets its place in the
 * tree (other imported pages may link to it), explaining what went wrong.
 */
async function placeholderPage(
  context: StepContext,
  item: ImportItemRow,
  message: string,
): Promise<void> {
  const exists = await context.env.DB.prepare('SELECT 1 AS found FROM pages WHERE id = ?')
    .bind(item.page_id)
    .first<{ found: number }>();
  if (exists) return;
  await context.deps.createMarkdownPage({
    actorId: context.actor.id,
    spaceId: context.job.space_id,
    title: item.title || '未能导入的内容',
    markdown: `> [!NOTE] ⚠️ 未能从 Notion 导入：${message}`,
    id: item.page_id,
    parentId: item.parent_page_id,
    sortKey: importSortKey(Number(context.job.created_at), Number(item.seq)),
    exactTitle: true,
  });
}

async function processItem(context: StepContext, item: ImportItemRow): Promise<void> {
  switch (item.kind) {
    case 'page':
      return processPage(context, item);
    case 'database':
      return processDatabase(context, item);
    case 'rows':
      return processRows(context, item);
    case 'row':
      return processRow(context, item);
  }
}

/** Work through the queue for about 20 seconds, then mark the job done if nothing is left. */
export async function runImportStep(
  env: Env,
  token: string,
  job: ImportJobRow,
  actor: AuthUserSummary,
  deps: NotionDependencies,
): Promise<void> {
  if (job.status !== 'running') return;
  const started = Date.now();
  await env.DB.prepare(
    `UPDATE notion_import_items SET status = 'pending'
      WHERE job_id = ? AND status = 'working' AND updated_at < ?`,
  )
    .bind(job.id, started - STALE_WORK_MS)
    .run();
  const context: StepContext = { env, token, actor, deps, job };
  while (Date.now() - started < STEP_BUDGET_MS) {
    const item = await claimNext(env, job.id);
    if (!item) break;
    let status: 'done' | 'failed' = 'done';
    let message: string | null = null;
    try {
      await processItem(context, item);
    } catch (reason) {
      message = (reason instanceof Error ? reason.message : '导入失败').slice(0, 500);
      const attempts = Number(item.attempts ?? 0);
      if (isTransientNotionError(reason) && attempts + 1 < MAX_ATTEMPTS) {
        // Back off and try again later; don't count it as failed.
        const delay = retryDelayMs(
          attempts,
          reason instanceof NotionError ? reason.retryAfterMs : null,
        );
        await env.DB.prepare(
          `UPDATE notion_import_items
              SET status = 'pending', attempts = attempts + 1, retry_at = ?,
                  error_message = ?, updated_at = ?
            WHERE id = ?`,
        )
          .bind(Date.now() + delay, message, Date.now(), item.id)
          .run();
        // A rate limit applies to every request: let it cool down.
        if (reason instanceof NotionError && reason.status === 429) break;
        continue;
      }
      status = 'failed';
      if (item.kind === 'page' || item.kind === 'database') {
        await placeholderPage(context, item, message).catch(() => undefined);
      }
    }
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE notion_import_items SET status = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      ).bind(status, message, Date.now(), item.id),
      env.DB.prepare(
        `UPDATE notion_import_jobs SET ${status === 'done' ? 'done = done + 1' : 'failed = failed + 1'},
           updated_at = ? WHERE id = ?`,
      ).bind(Date.now(), job.id),
    ]);
  }
  const remaining = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM notion_import_items
      WHERE job_id = ? AND status IN ('pending', 'working')`,
  )
    .bind(job.id)
    .first<{ count: number }>();
  if (Number(remaining?.count ?? 0) === 0) {
    const now = Date.now();
    await env.DB.prepare(
      `UPDATE notion_import_jobs SET status = 'completed', updated_at = ?, finished_at = ?
        WHERE id = ? AND status = 'running'`,
    )
      .bind(now, now, job.id)
      .run();
  }
}

/**
 * Keep running imports moving from the scheduled worker, as the person who
 * started them, so an import finishes even with the settings page closed.
 * Jobs a browser stepped in the last 30 s are left to it.
 */
export async function continueNotionImports(env: Env, deps: NotionDependencies): Promise<number> {
  const jobs = (
    await env.DB.prepare(
      `SELECT * FROM notion_import_jobs
        WHERE status = 'running' AND updated_at < ?
        ORDER BY updated_at LIMIT 2`,
    )
      .bind(Date.now() - 30_000)
      .all<ImportJobRow>()
  ).results;
  let continued = 0;
  for (const job of jobs) {
    const [token, actor] = await Promise.all([
      notionToken(env, job.organization_id),
      activeUser(env, job.created_by),
    ]);
    if (!token || !actor) continue;
    await env.DB.prepare('UPDATE notion_import_jobs SET updated_at = ? WHERE id = ?')
      .bind(Date.now(), job.id)
      .run();
    await runImportStep(env, token, job, actor, deps);
    continued += 1;
  }
  return continued;
}

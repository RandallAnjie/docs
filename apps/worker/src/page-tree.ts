import type {
  PageAccessMode,
  PageGrantRole,
  PageSummary,
  SpaceGrantPrincipalType,
} from '@rdocs/shared';

import { effectivePageGrantRole, requireSpaceAction } from './access';
import type { Env } from './env';

const MAX_PAGE_TREE_SIZE = 500;

interface PageTreeRow {
  id: string;
  organization_id: string;
  space_id: string;
  parent_id: string | null;
  title: string;
  icon: string | null;
  cover_attachment_id: string | null;
  font_style: 'sans' | 'serif' | 'mono';
  is_full_width: number;
  is_small_text: number;
  is_locked: number;
  current_generation: number;
  editor_schema_version: number;
  updated_at: number;
  collaboration_enabled: number;
  acl_version: number;
  access_mode: PageAccessMode;
}

interface ApplicablePageGrantRow {
  page_id: string;
  principal_type: SpaceGrantPrincipalType;
  role: PageGrantRole;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function pageFromRow(row: PageTreeRow): PageSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    spaceId: row.space_id,
    parentId: row.parent_id,
    title: row.title,
    icon: row.icon,
    coverAttachmentId: row.cover_attachment_id,
    fontStyle: row.font_style,
    isFullWidth: Boolean(row.is_full_width),
    isSmallText: Boolean(row.is_small_text),
    isLocked: Boolean(row.is_locked),
    currentGeneration: Number(row.current_generation),
    editorSchemaVersion: Number(row.editor_schema_version),
    updatedAt: Number(row.updated_at),
    collaborationEnabled: Boolean(row.collaboration_enabled),
    aclVersion: Number(row.acl_version),
  };
}

/**
 * Returns the closest restricted ancestor, null when the page inherits its
 * space access, or undefined when the loaded tree is structurally incomplete.
 * Incomplete/cyclic paths are hidden rather than risking an ACL bypass.
 */
function restrictedBoundary(
  page: PageTreeRow,
  pagesById: ReadonlyMap<string, PageTreeRow>,
): string | null | undefined {
  let current: PageTreeRow | undefined = page;
  const visited = new Set<string>();
  while (current) {
    if (visited.has(current.id)) return undefined;
    visited.add(current.id);
    if (current.access_mode === 'restricted') return current.id;
    if (!current.parent_id) return null;
    current = pagesById.get(current.parent_id);
    if (!current) return undefined;
  }
  return undefined;
}

export async function listPages(env: Env, spaceId: string, userId: string): Promise<Response> {
  const access = await requireSpaceAction(env, spaceId, userId, 'view');
  if (!access) return json({ error: '空间不存在或无权访问' }, { status: 404 });

  const rows = (
    await env.DB.prepare(
      `WITH RECURSIVE database_row_subtree(id) AS (
         SELECT r.page_id
           FROM database_rows r
          WHERE r.organization_id = ? AND r.archived_at IS NULL
         UNION ALL
         SELECT child.id
           FROM pages child JOIN database_row_subtree parent ON child.parent_id = parent.id
          WHERE child.deleted_at IS NULL
       )
       SELECT p.id, p.organization_id, p.space_id, p.parent_id, p.title,
              p.icon, p.cover_attachment_id, p.font_style,
              p.is_full_width, p.is_small_text, p.is_locked,
              p.current_generation, p.editor_schema_version, p.updated_at,
              a.collaboration_enabled, a.acl_version, a.access_mode
         FROM pages p
         JOIN page_access_state a ON a.page_id = p.id
        WHERE p.organization_id = ? AND p.space_id = ? AND p.deleted_at IS NULL
          AND p.id NOT IN (SELECT id FROM database_row_subtree)
          AND NOT EXISTS (SELECT 1 FROM database_templates t WHERE t.page_id = p.id)
        ORDER BY p.sort_key ASC, p.id ASC
        LIMIT ?`,
    )
      .bind(access.organizationId, access.organizationId, spaceId, MAX_PAGE_TREE_SIZE)
      .all<PageTreeRow>()
  ).results;

  if (access.spaceRole === 'space_admin') {
    return json({ pages: rows.map(pageFromRow) });
  }

  // Resolve every grant applicable to this user in one D1 call. The previous
  // implementation called the complete page ACL resolver once per row, which
  // turned a 72-page tree into more than 200 sequential D1 round trips.
  const grants = (
    await env.DB.prepare(
      `SELECT pg.page_id, pg.principal_type, pg.role
         FROM page_grants pg
         JOIN pages p ON p.id = pg.page_id
        WHERE pg.organization_id = ?
          AND p.organization_id = ? AND p.space_id = ? AND p.deleted_at IS NULL
          AND (
            (pg.principal_type = 'user' AND pg.principal_id = ?)
            OR (
              pg.principal_type = 'organization'
              AND pg.principal_id = ? AND ? <> 'guest'
            )
            OR (
              pg.principal_type = 'group' AND EXISTS (
                SELECT 1 FROM group_members gm
                 WHERE gm.group_id = pg.principal_id AND gm.user_id = ?
              )
            )
          )`,
    )
      .bind(
        access.organizationId,
        access.organizationId,
        spaceId,
        userId,
        access.organizationId,
        access.role,
        userId,
      )
      .all<ApplicablePageGrantRow>()
  ).results;
  const grantsByBoundary = new Map<string, ApplicablePageGrantRow[]>();
  for (const grant of grants) {
    const existing = grantsByBoundary.get(grant.page_id) ?? [];
    existing.push(grant);
    grantsByBoundary.set(grant.page_id, existing);
  }
  const pagesById = new Map(rows.map((row) => [row.id, row]));
  const pages = rows
    .filter((row) => {
      const boundary = restrictedBoundary(row, pagesById);
      if (boundary === null) return true;
      if (boundary === undefined) return false;
      return Boolean(
        effectivePageGrantRole(
          (grantsByBoundary.get(boundary) ?? []).map((grant) => ({
            principalType: grant.principal_type,
            role: grant.role,
          })),
        ),
      );
    })
    .map(pageFromRow);
  return json({ pages });
}

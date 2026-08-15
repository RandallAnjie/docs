import type {
  PageAccessMode,
  PageGrantRole,
  PageGrantSummary,
  SpaceGrantPrincipalType,
} from '@rdocs/shared';

import type { Env } from './env';

interface PageGrantRow {
  id: string;
  organization_id: string;
  page_id: string;
  principal_type: SpaceGrantPrincipalType;
  principal_id: string;
  role: PageGrantRole;
  created_at: number;
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function pageGrantFromRow(row: PageGrantRow): PageGrantSummary {
  return {
    id: row.id,
    organizationId: row.organization_id,
    pageId: row.page_id,
    principalType: row.principal_type,
    principalId: row.principal_id,
    role: row.role,
    createdAt: Number(row.created_at),
  };
}

export async function pageAccessSnapshot(env: Env, pageId: string): Promise<Response> {
  const [mode, rows] = await Promise.all([
    env.DB.prepare('SELECT access_mode FROM page_access_state WHERE page_id = ?')
      .bind(pageId)
      .first<{ access_mode: PageAccessMode }>(),
    env.DB.prepare(
      `SELECT id, organization_id, page_id, principal_type, principal_id, role, created_at
         FROM page_grants WHERE page_id = ? ORDER BY created_at ASC, id ASC`,
    )
      .bind(pageId)
      .all<PageGrantRow>(),
  ]);
  return json({
    mode: mode?.access_mode ?? 'inherit',
    grants: rows.results.map(pageGrantFromRow),
  });
}

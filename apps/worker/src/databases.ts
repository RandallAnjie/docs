import {
  EDITOR_SCHEMA_VERSION,
  isPageId,
  type AuthUserSummary,
  type DatabasePropertySummary,
  type DatabasePropertyType,
  type DatabaseRowSummary,
  type DatabaseSnapshot,
  type DatabaseSummary,
  type DatabaseTemplateSummary,
  type DatabaseViewSummary,
  type DatabaseViewType,
  type DatabaseFormLinkSummary,
  type DatabaseAutomationAction,
  type DatabaseAutomationRunSummary,
  type DatabaseAutomationSummary,
  type DatabaseAutomationTrigger,
  type JsonValue,
  type PublicDatabaseFormDefinition,
  type ProjectWorkspaceSummary,
  type SpaceRole,
} from '@rdocs/shared';

import {
  effectivePageGrantRole,
  findActiveMembership,
  requirePageAction,
  requireSpaceAction,
} from './access';
import { evaluateDatabaseFormulaProperties } from './database-formula-graph';
import { isComputedDatabaseProperty, normalizeDatabaseCellValue } from './database-values';
import { automationConditionMatches, parseSimpleCron } from './cron';
import type { Env } from './env';
import { copyPageContent, PageContentCopyError } from './page-content-copy';
import { searchIndexText } from './search-projection';

const MAX_DATABASE_ROWS = 500;
const MAX_DATABASE_PROPERTIES = 100;
const MAX_DATABASE_VIEWS = 50;
const MAX_DATABASE_TEMPLATES = 50;
const MAX_PROPERTY_NAME_LENGTH = 100;
const MAX_VIEW_NAME_LENGTH = 100;
const MAX_CONFIG_BYTES = 50_000;
const PUBLIC_FORM_ACTOR_ID = 'usr_rdocs_forms';
const PUBLIC_FORM_RATE_LIMIT_PER_MINUTE = 30;
const MAX_DATABASE_AUTOMATIONS = 100;
const AUTOMATION_TRIGGERS = new Set<DatabaseAutomationTrigger>([
  'row_created',
  'row_updated',
  'property_changed',
  'form_submitted',
  'manual',
]);
const AUTOMATION_ACTIONS = new Set<DatabaseAutomationAction>([
  'set_property',
  'toggle_checkbox',
  'increment_number',
  'archive_row',
  'webhook',
]);
const PUBLIC_FORM_PROPERTY_TYPES = new Set<DatabasePropertyType>([
  'title',
  'text',
  'number',
  'select',
  'status',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'email',
  'phone',
]);

const PROPERTY_TYPES = new Set<DatabasePropertyType>([
  'title',
  'text',
  'number',
  'select',
  'status',
  'multi_select',
  'date',
  'formula',
  'relation',
  'rollup',
  'person',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'button',
  'unique_id',
  'place',
]);

const VIEW_TYPES = new Set<DatabaseViewType>([
  'table',
  'board',
  'timeline',
  'calendar',
  'list',
  'gallery',
  'chart',
  'dashboard',
  'form',
  'feed',
  'map',
]);

interface DatabaseRecord {
  id: string;
  organization_id: string;
  page_id: string;
  title: string;
  is_locked: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface PropertyRecord {
  id: string;
  database_id: string;
  name: string;
  type: DatabasePropertyType;
  config_json: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface ViewRecord {
  id: string;
  database_id: string;
  name: string;
  type: DatabaseViewType;
  config_json: string;
  sort_order: number;
  created_at: number;
  updated_at: number;
}

interface RowRecord {
  id: string;
  database_id: string;
  page_id: string;
  sort_key: string;
  sequence_number: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
}

interface CellRecord {
  row_id: string;
  property_id: string;
  value_json: string;
}

interface FormLinkRecord {
  id: string;
  organization_id: string;
  database_id: string;
  view_id: string;
  token_hash: string;
  status: 'active' | 'revoked';
  expires_at: number | null;
  created_by: string;
  created_at: number;
  revoked_at: number | null;
  database_title?: string;
  view_name?: string;
  view_config_json?: string;
  page_id?: string;
  is_locked?: number;
  database_created_by?: string;
  database_updated_by?: string;
  database_created_at?: number;
  database_updated_at?: number;
}

interface TemplateRecord {
  id: string;
  database_id: string;
  page_id: string;
  name: string;
  description: string;
  values_json: string;
  is_default: number;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface AutomationRecord {
  id: string;
  database_id: string;
  name: string;
  enabled: number;
  trigger_type: DatabaseAutomationTrigger;
  trigger_config_json: string;
  action_type: DatabaseAutomationAction;
  action_config_json: string;
  created_by: string;
  updated_by: string;
  created_at: number;
  updated_at: number;
}

interface AutomationRunRecord {
  id: string;
  database_id: string;
  automation_id: string;
  row_id: string | null;
  trigger_type: DatabaseAutomationTrigger;
  status: 'running' | 'succeeded' | 'failed' | 'skipped';
  attempt: number;
  response_code: number | null;
  error_message: string | null;
  started_at: number;
  completed_at: number | null;
}

interface DatabaseAuthorization {
  database: DatabaseRecord;
  role: SpaceRole;
}

interface RowGrantRecord {
  page_id: string;
  principal_type: 'user' | 'group' | 'organization';
  role: 'none' | SpaceRole;
}

function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(data), { ...init, headers });
}

function error(message: string, status: number, code?: string): Response {
  return json({ error: message, ...(code ? { code } : {}) }, { status });
}

async function requestBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json<unknown>().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function entityName(value: unknown, maximum: number): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name && name.length <= maximum ? name : null;
}

function jsonObject(value: unknown): Record<string, JsonValue> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    const encoded = JSON.stringify(value);
    if (encoded.length > MAX_CONFIG_BYTES) return null;
    return JSON.parse(encoded) as Record<string, JsonValue>;
  } catch {
    return null;
  }
}

function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parsedObject(value: string): Record<string, JsonValue> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, JsonValue>)
      : {};
  } catch {
    return {};
  }
}

function parsedValue(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return null;
  }
}

function formLinkSummary(record: FormLinkRecord): DatabaseFormLinkSummary {
  return {
    id: record.id,
    databaseId: record.database_id,
    viewId: record.view_id,
    status: record.status,
    expiresAt: record.expires_at === null ? null : Number(record.expires_at),
    createdAt: Number(record.created_at),
    revokedAt: record.revoked_at === null ? null : Number(record.revoked_at),
  };
}

function templateSummary(record: TemplateRecord, includeValues = false): DatabaseTemplateSummary {
  return {
    id: record.id,
    databaseId: record.database_id,
    pageId: record.page_id,
    name: record.name,
    description: record.description,
    values: includeValues ? parsedObject(record.values_json) : {},
    isDefault: Boolean(record.is_default),
    createdBy: record.created_by,
    updatedBy: record.updated_by,
    createdAt: Number(record.created_at),
    updatedAt: Number(record.updated_at),
  };
}

function automationSummary(record: AutomationRecord): DatabaseAutomationSummary {
  const actionConfig = parsedObject(record.action_config_json);
  if (typeof actionConfig.secret === 'string') {
    delete actionConfig.secret;
    actionConfig.hasSecret = true;
  }
  return {
    id: record.id,
    databaseId: record.database_id,
    name: record.name,
    enabled: Boolean(record.enabled),
    triggerType: record.trigger_type,
    triggerConfig: parsedObject(record.trigger_config_json),
    actionType: record.action_type,
    actionConfig,
    createdBy: record.created_by,
    updatedBy: record.updated_by,
    createdAt: Number(record.created_at),
    updatedAt: Number(record.updated_at),
  };
}

function automationRunSummary(record: AutomationRunRecord): DatabaseAutomationRunSummary {
  return {
    id: record.id,
    databaseId: record.database_id,
    automationId: record.automation_id,
    rowId: record.row_id,
    triggerType: record.trigger_type,
    status: record.status,
    attempt: Number(record.attempt),
    responseCode: record.response_code === null ? null : Number(record.response_code),
    errorMessage: record.error_message,
    startedAt: Number(record.started_at),
    completedAt: record.completed_at === null ? null : Number(record.completed_at),
  };
}

async function sha256Text(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function randomFormToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function databaseSummary(record: DatabaseRecord, role: SpaceRole): DatabaseSummary {
  return {
    id: record.id,
    organizationId: record.organization_id,
    pageId: record.page_id,
    title: record.title,
    isLocked: Boolean(record.is_locked),
    role,
    createdBy: record.created_by,
    updatedBy: record.updated_by,
    createdAt: Number(record.created_at),
    updatedAt: Number(record.updated_at),
  };
}

function propertySummary(record: PropertyRecord): DatabasePropertySummary {
  return {
    id: record.id,
    databaseId: record.database_id,
    name: record.name,
    type: record.type,
    config: parsedObject(record.config_json),
    sortOrder: Number(record.sort_order),
    createdAt: Number(record.created_at),
    updatedAt: Number(record.updated_at),
  };
}

function viewSummary(record: ViewRecord): DatabaseViewSummary {
  return {
    id: record.id,
    databaseId: record.database_id,
    name: record.name,
    type: record.type,
    config: parsedObject(record.config_json),
    sortOrder: Number(record.sort_order),
    createdAt: Number(record.created_at),
    updatedAt: Number(record.updated_at),
  };
}

async function findDatabase(env: Env, databaseId: string): Promise<DatabaseRecord | null> {
  return env.DB.prepare(
    `SELECT d.id, d.organization_id, d.page_id, p.title, d.is_locked,
            d.created_by, d.updated_by, d.created_at, d.updated_at
       FROM databases d JOIN pages p ON p.id = d.page_id
      WHERE d.id = ? AND p.deleted_at IS NULL`,
  )
    .bind(databaseId)
    .first<DatabaseRecord>();
}

async function findDatabaseByPage(env: Env, pageId: string): Promise<DatabaseRecord | null> {
  return env.DB.prepare(
    `SELECT d.id, d.organization_id, d.page_id, p.title, d.is_locked,
            d.created_by, d.updated_by, d.created_at, d.updated_at
       FROM databases d JOIN pages p ON p.id = d.page_id
      WHERE d.page_id = ? AND p.deleted_at IS NULL`,
  )
    .bind(pageId)
    .first<DatabaseRecord>();
}

async function listOrganizationDatabases(
  env: Env,
  organizationId: string,
  actorId: string,
): Promise<Response> {
  if (!(await findActiveMembership(env, organizationId, actorId))) {
    return error('组织不存在或无权访问', 404);
  }
  const records = (
    await env.DB.prepare(
      `SELECT d.id, d.organization_id, d.page_id, p.title, d.is_locked,
              d.created_by, d.updated_by, d.created_at, d.updated_at
         FROM databases d JOIN pages p ON p.id = d.page_id
        WHERE d.organization_id = ? AND p.deleted_at IS NULL
        ORDER BY d.updated_at DESC LIMIT 200`,
    )
      .bind(organizationId)
      .all<DatabaseRecord>()
  ).results;
  const authorized = await Promise.all(
    records.map(async (database) => {
      const access = await requirePageAction(env, database.page_id, actorId, 'view');
      return access ? databaseSummary(database, access.spaceRole) : null;
    }),
  );
  return json({ databases: authorized.filter((database) => database !== null) });
}

async function authorizeDatabase(
  env: Env,
  databaseId: string,
  actorId: string,
  action: 'view' | 'edit_content' | 'manage_access',
): Promise<DatabaseAuthorization | null> {
  const database = await findDatabase(env, databaseId);
  if (!database) return null;
  const access = await requirePageAction(env, database.page_id, actorId, action);
  return access && access.organizationId === database.organization_id
    ? { database, role: access.spaceRole }
    : null;
}

async function authorizeDatabasePage(
  env: Env,
  pageId: string,
  actorId: string,
  action: 'view' | 'edit_content' | 'manage_access',
): Promise<DatabaseAuthorization | null> {
  const database = await findDatabaseByPage(env, pageId);
  if (!database) return null;
  const access = await requirePageAction(env, pageId, actorId, action);
  return access && access.organizationId === database.organization_id
    ? { database, role: access.spaceRole }
    : null;
}

async function visibleDatabaseRows(
  env: Env,
  authorization: DatabaseAuthorization,
  rows: RowRecord[],
  actorId: string,
): Promise<RowRecord[]> {
  if (!rows.length || authorization.role === 'space_admin') return rows;
  const pageIds = rows.map((row) => row.page_id);
  const placeholders = pageIds.map(() => '?').join(', ');
  const restricted = (
    await env.DB.prepare(
      `SELECT page_id FROM page_access_state
        WHERE access_mode = 'restricted' AND page_id IN (${placeholders})`,
    )
      .bind(...pageIds)
      .all<{ page_id: string }>()
  ).results;
  if (!restricted.length) return rows;
  const restrictedIds = new Set(restricted.map((row) => row.page_id));
  const restrictedPlaceholders = restricted.map(() => '?').join(', ');
  const membership = await findActiveMembership(
    env,
    authorization.database.organization_id,
    actorId,
  );
  if (!membership) return [];
  const grants = (
    await env.DB.prepare(
      `SELECT pg.page_id, pg.principal_type, pg.role
         FROM page_grants pg
        WHERE pg.organization_id = ? AND pg.page_id IN (${restrictedPlaceholders})
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
        authorization.database.organization_id,
        ...restricted.map((row) => row.page_id),
        actorId,
        authorization.database.organization_id,
        membership.role,
        actorId,
      )
      .all<RowGrantRecord>()
  ).results;
  const grantsByPage = new Map<string, RowGrantRecord[]>();
  for (const grant of grants) {
    grantsByPage.set(grant.page_id, [...(grantsByPage.get(grant.page_id) ?? []), grant]);
  }
  return rows.filter(
    (row) =>
      !restrictedIds.has(row.page_id) ||
      Boolean(
        effectivePageGrantRole(
          (grantsByPage.get(row.page_id) ?? []).map((grant) => ({
            principalType: grant.principal_type,
            role: grant.role,
          })),
        ),
      ),
  );
}

async function databaseAudit(
  env: Env,
  database: DatabaseRecord,
  actorId: string,
  eventType: string,
  targetType:
    'database' | 'database_property' | 'database_view' | 'database_row' | 'database_template',
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_events(
       id, organization_id, actor_id, event_type, target_type,
       target_id, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      crypto.randomUUID(),
      database.organization_id,
      actorId,
      eventType,
      targetType,
      targetId,
      JSON.stringify(metadata),
      Date.now(),
    )
    .run();
}

function rollup(values: JsonValue[], calculation: string): JsonValue {
  switch (calculation) {
    case 'show_original':
      return values;
    case 'show_unique':
      return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
    case 'count_all':
      return values.length;
    case 'count_values':
    case 'count_not_empty':
      return values.filter((value) => value !== null && value !== '').length;
    case 'count_unique':
      return new Set(values.map((value) => JSON.stringify(value))).size;
    case 'count_empty':
      return values.filter((value) => value === null || value === '').length;
    case 'percent_empty':
      return values.length
        ? (values.filter((value) => value === null || value === '').length / values.length) * 100
        : 0;
    case 'percent_not_empty':
      return values.length
        ? (values.filter((value) => value !== null && value !== '').length / values.length) * 100
        : 0;
    case 'percent_checked':
      return values.length
        ? (values.filter((value) => value === true).length / values.length) * 100
        : 0;
    case 'sum':
      return values.reduce<number>(
        (total, value) => total + (typeof value === 'number' ? value : 0),
        0,
      );
    case 'average': {
      const numbers = values.filter((value): value is number => typeof value === 'number');
      return numbers.length
        ? numbers.reduce((total, value) => total + value, 0) / numbers.length
        : 0;
    }
    case 'min': {
      const numbers = values.filter((value): value is number => typeof value === 'number');
      return numbers.length ? Math.min(...numbers) : null;
    }
    case 'max': {
      const numbers = values.filter((value): value is number => typeof value === 'number');
      return numbers.length ? Math.max(...numbers) : null;
    }
    case 'earliest_date':
    case 'latest_date': {
      const dates = values
        .flatMap((value) => {
          if (typeof value === 'string') return [value];
          if (value && !Array.isArray(value) && typeof value === 'object') {
            const start = value.start;
            return typeof start === 'string' ? [start] : [];
          }
          return [];
        })
        .sort();
      return calculation === 'earliest_date' ? (dates[0] ?? null) : (dates.at(-1) ?? null);
    }
    default:
      return values.length;
  }
}

async function relationDatabaseAuthorizations(
  env: Env,
  properties: DatabasePropertySummary[],
  actorId: string,
): Promise<Map<string, DatabaseAuthorization | null>> {
  const databaseIds = [
    ...new Set(
      properties.flatMap((property) => {
        const target = property.config.targetDatabaseId;
        return typeof target === 'string' ? [target] : [];
      }),
    ),
  ];
  const visibility = new Map<string, DatabaseAuthorization | null>();
  await Promise.all(
    databaseIds.map(async (databaseId) => {
      visibility.set(databaseId, await authorizeDatabase(env, databaseId, actorId, 'view'));
    }),
  );
  return visibility;
}

async function visibleRelatedRowIds(
  env: Env,
  properties: DatabasePropertySummary[],
  rows: RowRecord[],
  rawValues: ReadonlyMap<string, Record<string, JsonValue>>,
  authorizations: ReadonlyMap<string, DatabaseAuthorization | null>,
  actorId: string,
): Promise<Map<string, Set<string>>> {
  const result = new Map<string, Set<string>>();
  await Promise.all(
    [...authorizations].map(async ([targetDatabaseId, authorization]) => {
      if (!authorization) {
        result.set(targetDatabaseId, new Set());
        return;
      }
      const relationPropertyIds = properties
        .filter(
          (property) =>
            property.type === 'relation' && property.config.targetDatabaseId === targetDatabaseId,
        )
        .map((property) => property.id);
      const rowIds = [
        ...new Set(
          rows.flatMap((row) =>
            relationPropertyIds.flatMap((propertyId) => {
              const value = rawValues.get(row.id)?.[propertyId];
              return Array.isArray(value)
                ? value.filter((item): item is string => typeof item === 'string')
                : [];
            }),
          ),
        ),
      ].slice(0, MAX_DATABASE_ROWS);
      if (!rowIds.length) {
        result.set(targetDatabaseId, new Set());
        return;
      }
      const placeholders = rowIds.map(() => '?').join(', ');
      const targetRows = (
        await env.DB.prepare(
          `SELECT id, database_id, page_id, sort_key, sequence_number, created_by, updated_by,
                  created_at, updated_at, archived_at
             FROM database_rows
            WHERE database_id = ? AND archived_at IS NULL AND id IN (${placeholders})`,
        )
          .bind(targetDatabaseId, ...rowIds)
          .all<RowRecord>()
      ).results;
      const visible = await visibleDatabaseRows(env, authorization, targetRows, actorId);
      result.set(targetDatabaseId, new Set(visible.map((row) => row.id)));
    }),
  );
  return result;
}

async function relatedValues(
  env: Env,
  properties: DatabasePropertySummary[],
  rows: RowRecord[],
  rawValues: Map<string, Record<string, JsonValue>>,
  visibility: ReadonlyMap<string, DatabaseAuthorization | null>,
  relatedRowIds: ReadonlyMap<string, ReadonlySet<string>>,
): Promise<Map<string, Record<string, JsonValue>>> {
  const result = new Map<string, Record<string, JsonValue>>();
  for (const property of properties.filter((candidate) => candidate.type === 'rollup')) {
    const relationPropertyId = property.config.relationPropertyId;
    const targetPropertyId = property.config.targetPropertyId;
    const targetDatabaseId = property.config.targetDatabaseId;
    const calculation = property.config.calculation;
    if (
      typeof relationPropertyId !== 'string' ||
      typeof targetPropertyId !== 'string' ||
      typeof targetDatabaseId !== 'string' ||
      typeof calculation !== 'string' ||
      !visibility.get(targetDatabaseId)
    ) {
      continue;
    }
    const allowedTargetRows = relatedRowIds.get(targetDatabaseId) ?? new Set<string>();
    const targetRowIds = [
      ...new Set(
        rows.flatMap((row) => {
          const value = rawValues.get(row.id)?.[relationPropertyId];
          return Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
        }),
      ),
    ]
      .filter((rowId) => allowedTargetRows.has(rowId))
      .slice(0, MAX_DATABASE_ROWS);
    if (!targetRowIds.length) {
      for (const row of rows) {
        const rowValues = result.get(row.id) ?? {};
        rowValues[property.id] = rollup([], calculation);
        result.set(row.id, rowValues);
      }
      continue;
    }
    const placeholders = targetRowIds.map(() => '?').join(', ');
    const targetCells = (
      await env.DB.prepare(
        `SELECT c.row_id, c.property_id, c.value_json
           FROM database_cells c JOIN database_rows r ON r.id = c.row_id
          WHERE c.database_id = ? AND c.property_id = ?
            AND c.row_id IN (${placeholders}) AND r.archived_at IS NULL`,
      )
        .bind(targetDatabaseId, targetPropertyId, ...targetRowIds)
        .all<CellRecord>()
    ).results;
    const byTargetRow = new Map(
      targetCells.map((cell) => [cell.row_id, parsedValue(cell.value_json)]),
    );
    for (const row of rows) {
      const relation = rawValues.get(row.id)?.[relationPropertyId];
      const values = Array.isArray(relation)
        ? relation.flatMap((targetRowId) =>
            typeof targetRowId === 'string' && byTargetRow.has(targetRowId)
              ? [byTargetRow.get(targetRowId) ?? null]
              : [],
          )
        : [];
      const rowValues = result.get(row.id) ?? {};
      rowValues[property.id] = rollup(values, calculation);
      result.set(row.id, rowValues);
    }
  }
  return result;
}

async function snapshot(
  env: Env,
  authorization: DatabaseAuthorization,
  actorId: string,
  rowState: 'active' | 'archived' = 'active',
): Promise<DatabaseSnapshot> {
  const archivedFilter = rowState === 'archived' ? 'IS NOT NULL' : 'IS NULL';
  const [propertyRecords, viewRecords, templateRecords, rows, cells] = await Promise.all([
    env.DB.prepare(
      `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
         FROM database_properties WHERE database_id = ? ORDER BY sort_order LIMIT ?`,
    )
      .bind(authorization.database.id, MAX_DATABASE_PROPERTIES)
      .all<PropertyRecord>(),
    env.DB.prepare(
      `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
         FROM database_views WHERE database_id = ? ORDER BY sort_order LIMIT ?`,
    )
      .bind(authorization.database.id, MAX_DATABASE_VIEWS)
      .all<ViewRecord>(),
    env.DB.prepare(
      `SELECT id, database_id, page_id, name, description, values_json, is_default,
              created_by, updated_by, created_at, updated_at
         FROM database_templates WHERE database_id = ?
        ORDER BY is_default DESC, updated_at DESC LIMIT ?`,
    )
      .bind(authorization.database.id, MAX_DATABASE_TEMPLATES)
      .all<TemplateRecord>(),
    env.DB.prepare(
      `SELECT id, database_id, page_id, sort_key, sequence_number, created_by, updated_by,
              created_at, updated_at, archived_at
         FROM database_rows WHERE database_id = ? AND archived_at ${archivedFilter}
        ORDER BY sort_key LIMIT ?`,
    )
      .bind(authorization.database.id, MAX_DATABASE_ROWS)
      .all<RowRecord>(),
    env.DB.prepare(
      `SELECT row_id, property_id, value_json FROM database_cells
        WHERE database_id = ?`,
    )
      .bind(authorization.database.id)
      .all<CellRecord>(),
  ]);
  const properties = propertyRecords.results.map(propertySummary);
  const views = viewRecords.results.map(viewSummary);
  const visibleRows = await visibleDatabaseRows(env, authorization, rows.results, actorId);
  const rawValues = new Map<string, Record<string, JsonValue>>();
  for (const cell of cells.results) {
    const values = rawValues.get(cell.row_id) ?? {};
    values[cell.property_id] = parsedValue(cell.value_json);
    rawValues.set(cell.row_id, values);
  }
  const visibility = await relationDatabaseAuthorizations(env, properties, actorId);
  const allowedRelatedRows = await visibleRelatedRowIds(
    env,
    properties,
    visibleRows,
    rawValues,
    visibility,
    actorId,
  );
  for (const property of properties.filter((candidate) => candidate.type === 'relation')) {
    const targetDatabaseId = property.config.targetDatabaseId;
    if (typeof targetDatabaseId !== 'string') continue;
    const allowed = allowedRelatedRows.get(targetDatabaseId) ?? new Set<string>();
    for (const row of visibleRows) {
      const values = rawValues.get(row.id);
      const relation = values?.[property.id];
      if (values && Array.isArray(relation)) {
        values[property.id] = relation.filter(
          (targetRowId): targetRowId is string =>
            typeof targetRowId === 'string' && allowed.has(targetRowId),
        );
      }
    }
  }
  const rollups = await relatedValues(
    env,
    properties,
    visibleRows,
    rawValues,
    visibility,
    allowedRelatedRows,
  );
  const rowSummaries: DatabaseRowSummary[] = visibleRows.map((row) => {
    const values = { ...(rawValues.get(row.id) ?? {}), ...(rollups.get(row.id) ?? {}) };
    for (const property of properties) {
      if (property.type === 'created_time') values[property.id] = Number(row.created_at);
      else if (property.type === 'created_by') values[property.id] = row.created_by;
      else if (property.type === 'last_edited_time') values[property.id] = Number(row.updated_at);
      else if (property.type === 'last_edited_by') values[property.id] = row.updated_by;
      else if (property.type === 'unique_id') {
        const prefix = typeof property.config.prefix === 'string' ? property.config.prefix : '';
        values[property.id] = `${prefix}${row.sequence_number}`;
      }
    }
    Object.assign(values, evaluateDatabaseFormulaProperties(properties, values));
    return {
      id: row.id,
      databaseId: row.database_id,
      pageId: row.page_id,
      sortKey: row.sort_key,
      sequenceNumber: Number(row.sequence_number),
      values,
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      archivedAt: row.archived_at === null ? null : Number(row.archived_at),
    };
  });
  const hiddenProperties = await hiddenDatabasePropertyIds(
    env,
    authorization.database.id,
    authorization.database.organization_id,
    actorId,
  );
  const visibleProperties = properties.filter(
    (property) => property.type === 'title' || !hiddenProperties.has(property.id),
  );
  const visiblePropertyIds = new Set(visibleProperties.map((property) => property.id));
  return {
    database: databaseSummary(authorization.database, authorization.role),
    properties: visibleProperties,
    views,
    rows: rowSummaries.map((row) => ({
      ...row,
      values: Object.fromEntries(
        Object.entries(row.values).filter(([propertyId]) => visiblePropertyIds.has(propertyId)),
      ),
    })),
    templates: templateRecords.results.map((record) => templateSummary(record)),
  };
}

async function hiddenDatabasePropertyIds(
  env: Env,
  databaseId: string,
  organizationId: string,
  actorId: string,
): Promise<Set<string>> {
  const grants = (
    await env.DB.prepare(
      `SELECT property_id, principal_type, principal_id, role
         FROM database_property_grants WHERE database_id = ?`,
    )
      .bind(databaseId)
      .all<{
        property_id: string;
        principal_type: 'user' | 'group' | 'organization';
        principal_id: string;
        role: 'none' | 'viewer' | 'editor';
      }>()
  ).results;
  if (!grants.length) return new Set();
  const groups = (
    await env.DB.prepare(
      `SELECT gm.group_id FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
        WHERE gm.user_id = ? AND g.organization_id = ?`,
    )
      .bind(actorId, organizationId)
      .all<{ group_id: string }>()
  ).results.map((row) => row.group_id);
  const groupSet = new Set(groups);
  const byProperty = new Map<string, typeof grants>();
  for (const grant of grants) {
    const current = byProperty.get(grant.property_id) ?? [];
    current.push(grant);
    byProperty.set(grant.property_id, current);
  }
  const hidden = new Set<string>();
  for (const [propertyId, propertyGrants] of byProperty) {
    const applicable = propertyGrants.filter((grant) => {
      if (grant.principal_type === 'user') return grant.principal_id === actorId;
      if (grant.principal_type === 'group') return groupSet.has(grant.principal_id);
      return grant.principal_id === organizationId || grant.principal_type === 'organization';
    });
    if (!applicable.length) {
      hidden.add(propertyId);
      continue;
    }
    if (applicable.some((grant) => grant.principal_type === 'user' && grant.role === 'none')) {
      hidden.add(propertyId);
      continue;
    }
    if (applicable.every((grant) => grant.role === 'none')) hidden.add(propertyId);
  }
  return hidden;
}

async function createDatabase(
  request: Request,
  env: Env,
  pageId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const access = await requirePageAction(env, pageId, actor.id, 'edit_content');
  if (!access) return error('页面不存在或无权创建数据库', 404);
  if (await findDatabaseByPage(env, pageId)) return error('此页面已经是数据库', 409);
  const input = (await requestBody(request)) ?? {};
  const titlePropertyName = entityName(input.titlePropertyName ?? '名称', MAX_PROPERTY_NAME_LENGTH);
  if (!titlePropertyName) return error('标题属性名称无效', 400);
  const databaseId = crypto.randomUUID();
  const propertyId = crypto.randomUUID();
  const viewId = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO databases(
         id, organization_id, page_id, is_locked, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
    ).bind(databaseId, access.organizationId, pageId, actor.id, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO database_counters(database_id, next_row_sequence) VALUES (?, 1)
       ON CONFLICT(database_id) DO NOTHING`,
    ).bind(databaseId),
    env.DB.prepare(
      `INSERT INTO database_properties(
         id, organization_id, database_id, name, type, config_json, sort_order,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'title', '{}', 0, ?, ?, ?)`,
    ).bind(propertyId, access.organizationId, databaseId, titlePropertyName, actor.id, now, now),
    env.DB.prepare(
      `INSERT INTO database_views(
         id, organization_id, database_id, name, type, config_json, sort_order,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, '表格', 'table', '{}', 0, ?, ?, ?)`,
    ).bind(viewId, access.organizationId, databaseId, actor.id, now, now),
  ]);
  const database = await findDatabase(env, databaseId);
  if (!database) throw new Error('database_create_result_missing');
  await databaseAudit(env, database, actor.id, 'database.created', 'database', databaseId);
  return json(await snapshot(env, { database, role: access.spaceRole }, actor.id), { status: 201 });
}

async function updateDatabase(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
): Promise<Response> {
  const input = await requestBody(request);
  if (!input) return error('请求格式无效', 400);
  let title: string | undefined;
  if ('title' in input) {
    title = entityName(input.title, 200) ?? undefined;
    if (!title) return error('数据库标题无效', 400);
  }
  let locked: boolean | undefined;
  if ('isLocked' in input) {
    if (typeof input.isLocked !== 'boolean') return error('isLocked 必须是布尔值', 400);
    if (
      !(await requirePageAction(env, authorization.database.page_id, actor.id, 'manage_access'))
    ) {
      return error('只有管理员可以锁定数据库', 403);
    }
    locked = input.isLocked;
  }
  if (title === undefined && locked === undefined) return error('没有可更新的字段', 400);
  const now = Date.now();
  const statements = [
    env.DB.prepare(
      'UPDATE databases SET is_locked = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    ).bind(
      locked === undefined ? authorization.database.is_locked : locked ? 1 : 0,
      actor.id,
      now,
      authorization.database.id,
    ),
  ];
  if (title !== undefined) {
    statements.push(
      env.DB.prepare(
        'UPDATE pages SET title = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      ).bind(title, actor.id, now, authorization.database.page_id),
      env.DB.prepare(
        'UPDATE page_search_projection SET title = ?, updated_at = ? WHERE page_id = ?',
      ).bind(title, now, authorization.database.page_id),
      env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(
        authorization.database.page_id,
      ),
      env.DB.prepare(
        `INSERT INTO page_search_fts(page_id, title, normalized_body)
         SELECT page_id, ?, normalized_body FROM page_search_projection WHERE page_id = ?`,
      ).bind(searchIndexText(title), authorization.database.page_id),
    );
  }
  await env.DB.batch(statements);
  const database = await findDatabase(env, authorization.database.id);
  if (!database) throw new Error('database_update_result_missing');
  await databaseAudit(env, database, actor.id, 'database.updated', 'database', database.id, {
    ...(title === undefined ? {} : { title }),
    ...(locked === undefined ? {} : { isLocked: locked }),
  });
  return json({ database: databaseSummary(database, authorization.role) });
}

function propertyType(value: unknown): DatabasePropertyType | null {
  return typeof value === 'string' && PROPERTY_TYPES.has(value as DatabasePropertyType)
    ? (value as DatabasePropertyType)
    : null;
}

function viewType(value: unknown): DatabaseViewType | null {
  return typeof value === 'string' && VIEW_TYPES.has(value as DatabaseViewType)
    ? (value as DatabaseViewType)
    : null;
}

async function validatePropertyConfig(
  env: Env,
  authorization: DatabaseAuthorization,
  actorId: string,
  type: DatabasePropertyType,
  config: Record<string, JsonValue>,
): Promise<string | null> {
  if (type === 'formula' && typeof config.expression !== 'string') return '公式属性需要 expression';
  if (type === 'relation') {
    if (typeof config.targetDatabaseId !== 'string' || !isPageId(config.targetDatabaseId)) {
      return '关系属性需要有效的目标数据库';
    }
    const target = await authorizeDatabase(env, config.targetDatabaseId, actorId, 'view');
    if (!target || target.database.organization_id !== authorization.database.organization_id) {
      return '目标数据库不存在或无权访问';
    }
  }
  if (type === 'rollup') {
    if (
      typeof config.relationPropertyId !== 'string' ||
      typeof config.targetDatabaseId !== 'string' ||
      typeof config.targetPropertyId !== 'string' ||
      typeof config.calculation !== 'string'
    ) {
      return '汇总属性配置不完整';
    }
    const relation = await env.DB.prepare(
      `SELECT config_json FROM database_properties
        WHERE id = ? AND database_id = ? AND type = 'relation'`,
    )
      .bind(config.relationPropertyId, authorization.database.id)
      .first<{ config_json: string }>();
    if (!relation) return '汇总引用的关系属性不存在';
    const relationConfig = parsedObject(relation.config_json);
    if (relationConfig.targetDatabaseId !== config.targetDatabaseId)
      return '汇总目标与关系属性不一致';
    const target = await authorizeDatabase(env, config.targetDatabaseId, actorId, 'view');
    if (!target || target.database.organization_id !== authorization.database.organization_id) {
      return '汇总目标数据库不存在或无权访问';
    }
    const targetProperty = await env.DB.prepare(
      'SELECT 1 AS found FROM database_properties WHERE id = ? AND database_id = ?',
    )
      .bind(config.targetPropertyId, config.targetDatabaseId)
      .first<{ found: number }>();
    if (!targetProperty) return '汇总目标属性不存在';
  }
  return null;
}

async function createProperty(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能修改属性', 409);
  const input = await requestBody(request);
  const name = entityName(input?.name, MAX_PROPERTY_NAME_LENGTH);
  const type = propertyType(input?.type);
  const requestedConfig = input?.config === undefined ? {} : jsonObject(input.config);
  if (!name || !type || !requestedConfig) return error('属性名称、类型或配置无效', 400);
  if (type === 'title') return error('数据库只能有一个标题属性', 409);
  const reciprocalName =
    type === 'relation' && typeof requestedConfig.reciprocalName === 'string'
      ? entityName(requestedConfig.reciprocalName, MAX_PROPERTY_NAME_LENGTH)
      : null;
  if (type === 'relation' && 'reciprocalName' in requestedConfig && !reciprocalName) {
    return error('双向关系属性名称无效', 400);
  }
  const config = { ...requestedConfig };
  delete config.reciprocalName;
  delete config.syncedPropertyId;
  const configError = await validatePropertyConfig(env, authorization, actor.id, type, config);
  if (configError) return error(configError, 400);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM database_properties WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_DATABASE_PROPERTIES) return error('数据库属性已达上限', 409);
  const order = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM database_properties WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ next: number }>();
  const id = crypto.randomUUID();
  let reciprocal:
    | {
        id: string;
        database: DatabaseRecord;
        name: string;
        order: number;
      }
    | undefined;
  if (type === 'relation' && reciprocalName) {
    const targetDatabaseId = config.targetDatabaseId as string;
    const target = await authorizeDatabase(env, targetDatabaseId, actor.id, 'edit_content');
    if (!target || target.database.organization_id !== authorization.database.organization_id) {
      return error('创建双向关系需要目标数据库的编辑权限', 403);
    }
    if (target.database.is_locked) return error('目标数据库已锁定', 409);
    const targetCount = await env.DB.prepare(
      'SELECT COUNT(*) AS count FROM database_properties WHERE database_id = ?',
    )
      .bind(targetDatabaseId)
      .first<{ count: number }>();
    const requiredSlots = targetDatabaseId === authorization.database.id ? 2 : 1;
    if (Number(targetCount?.count ?? 0) + requiredSlots > MAX_DATABASE_PROPERTIES) {
      return error('目标数据库属性已达上限', 409);
    }
    const targetOrder = await env.DB.prepare(
      'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM database_properties WHERE database_id = ?',
    )
      .bind(targetDatabaseId)
      .first<{ next: number }>();
    reciprocal = {
      id: crypto.randomUUID(),
      database: target.database,
      name: reciprocalName,
      order:
        targetDatabaseId === authorization.database.id
          ? Number(order?.next ?? 0) + 1
          : Number(targetOrder?.next ?? 0),
    };
    config.syncedPropertyId = reciprocal.id;
  }
  const now = Date.now();
  try {
    const statements = [
      env.DB.prepare(
        `INSERT INTO database_properties(
           id, organization_id, database_id, name, type, config_json, sort_order,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        authorization.database.organization_id,
        authorization.database.id,
        name,
        type,
        JSON.stringify(config),
        Number(order?.next ?? 0),
        actor.id,
        now,
        now,
      ),
      env.DB.prepare('UPDATE databases SET updated_by = ?, updated_at = ? WHERE id = ?').bind(
        actor.id,
        now,
        authorization.database.id,
      ),
    ];
    if (reciprocal) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO database_properties(
             id, organization_id, database_id, name, type, config_json, sort_order,
             created_by, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'relation', ?, ?, ?, ?, ?)`,
        ).bind(
          reciprocal.id,
          reciprocal.database.organization_id,
          reciprocal.database.id,
          reciprocal.name,
          JSON.stringify({
            targetDatabaseId: authorization.database.id,
            syncedPropertyId: id,
          }),
          reciprocal.order,
          actor.id,
          now,
          now,
        ),
        env.DB.prepare('UPDATE databases SET updated_by = ?, updated_at = ? WHERE id = ?').bind(
          actor.id,
          now,
          reciprocal.database.id,
        ),
      );
    }
    await env.DB.batch(statements);
  } catch {
    return error('属性名称已存在', 409);
  }
  const property = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_properties WHERE id = ?`,
  )
    .bind(id)
    .first<PropertyRecord>();
  if (!property) throw new Error('database_property_create_result_missing');
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.property.created',
    'database_property',
    id,
    {
      type,
    },
  );
  const reciprocalProperty = reciprocal
    ? await env.DB.prepare(
        `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
           FROM database_properties WHERE id = ?`,
      )
        .bind(reciprocal.id)
        .first<PropertyRecord>()
    : null;
  return json(
    {
      property: propertySummary(property),
      ...(reciprocalProperty ? { reciprocalProperty: propertySummary(reciprocalProperty) } : {}),
    },
    { status: 201 },
  );
}

async function updateProperty(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  propertyId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能修改属性', 409);
  const existing = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_properties WHERE id = ? AND database_id = ?`,
  )
    .bind(propertyId, authorization.database.id)
    .first<PropertyRecord>();
  if (!existing) return error('属性不存在', 404);
  const input = await requestBody(request);
  if (!input) return error('请求格式无效', 400);
  const name = 'name' in input ? entityName(input.name, MAX_PROPERTY_NAME_LENGTH) : existing.name;
  const existingConfig = parsedObject(existing.config_json);
  const config = 'config' in input ? jsonObject(input.config) : existingConfig;
  if (!name || !config) return error('属性名称或配置无效', 400);
  if (existing.type === 'relation') {
    if (config.targetDatabaseId !== existingConfig.targetDatabaseId) {
      return error('关系创建后不能更换目标数据库，请新建关系属性', 409);
    }
    if (existingConfig.syncedPropertyId) {
      config.syncedPropertyId = existingConfig.syncedPropertyId;
    } else {
      delete config.syncedPropertyId;
    }
    delete config.reciprocalName;
  }
  const configError = await validatePropertyConfig(
    env,
    authorization,
    actor.id,
    existing.type,
    config,
  );
  if (configError) return error(configError, 400);
  const now = Date.now();
  try {
    await env.DB.prepare(
      `UPDATE database_properties SET name = ?, config_json = ?, updated_at = ?
        WHERE id = ? AND database_id = ?`,
    )
      .bind(name, JSON.stringify(config), now, propertyId, authorization.database.id)
      .run();
  } catch {
    return error('属性名称已存在', 409);
  }
  const property = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_properties WHERE id = ?`,
  )
    .bind(propertyId)
    .first<PropertyRecord>();
  if (!property) throw new Error('database_property_update_result_missing');
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.property.updated',
    'database_property',
    propertyId,
  );
  return json({ property: propertySummary(property) });
}

async function deleteProperty(
  env: Env,
  authorization: DatabaseAuthorization,
  propertyId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能删除属性', 409);
  const property = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_properties WHERE id = ? AND database_id = ?`,
  )
    .bind(propertyId, authorization.database.id)
    .first<PropertyRecord>();
  if (!property) return error('属性不存在', 404);
  if (property.type === 'title') return error('不能删除标题属性', 409);
  const config = parsedObject(property.config_json);
  const syncedPropertyId =
    property.type === 'relation' && typeof config.syncedPropertyId === 'string'
      ? config.syncedPropertyId
      : null;
  if (syncedPropertyId) {
    const reciprocal = await env.DB.prepare(
      `SELECT d.id AS database_id, d.is_locked
         FROM database_properties p JOIN databases d ON d.id = p.database_id
        WHERE p.id = ?`,
    )
      .bind(syncedPropertyId)
      .first<{ database_id: string; is_locked: number }>();
    if (reciprocal) {
      if (!(await authorizeDatabase(env, reciprocal.database_id, actor.id, 'edit_content'))) {
        return error('删除双向关系需要目标数据库的编辑权限', 403);
      }
      if (reciprocal.is_locked) return error('目标数据库已锁定', 409);
    }
  }
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM database_properties WHERE id = ? AND database_id = ?').bind(
      propertyId,
      authorization.database.id,
    ),
    ...(property.type === 'date'
      ? [
          env.DB.prepare(
            `UPDATE page_reminders
                SET status = 'cancelled', cancelled_at = ?, updated_at = ?
              WHERE source_type = 'database_date' AND status = 'scheduled'
                AND source_id LIKE ?
                AND page_id IN (
                  SELECT page_id FROM database_rows WHERE database_id = ?
                )`,
          ).bind(now, now, `%:${propertyId}`, authorization.database.id),
        ]
      : []),
    ...(syncedPropertyId
      ? [env.DB.prepare('DELETE FROM database_properties WHERE id = ?').bind(syncedPropertyId)]
      : []),
  ]);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.property.deleted',
    'database_property',
    propertyId,
  );
  return json({ ok: true });
}

async function createView(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能修改视图', 409);
  const input = await requestBody(request);
  const name = entityName(input?.name, MAX_VIEW_NAME_LENGTH);
  const type = viewType(input?.type);
  const config = input?.config === undefined ? {} : jsonObject(input.config);
  if (!name || !type || !config) return error('视图名称、类型或配置无效', 400);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM database_views WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_DATABASE_VIEWS) return error('数据库视图已达上限', 409);
  const order = await env.DB.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM database_views WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ next: number }>();
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO database_views(
       id, organization_id, database_id, name, type, config_json, sort_order,
       created_by, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      authorization.database.organization_id,
      authorization.database.id,
      name,
      type,
      JSON.stringify(config),
      Number(order?.next ?? 0),
      actor.id,
      now,
      now,
    )
    .run();
  const view = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_views WHERE id = ?`,
  )
    .bind(id)
    .first<ViewRecord>();
  if (!view) throw new Error('database_view_create_result_missing');
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.view.created',
    'database_view',
    id,
    { type },
  );
  return json({ view: viewSummary(view) }, { status: 201 });
}

async function updateView(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  viewId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能修改视图', 409);
  const existing = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_views WHERE id = ? AND database_id = ?`,
  )
    .bind(viewId, authorization.database.id)
    .first<ViewRecord>();
  if (!existing) return error('视图不存在', 404);
  const input = await requestBody(request);
  if (!input) return error('请求格式无效', 400);
  const name = 'name' in input ? entityName(input.name, MAX_VIEW_NAME_LENGTH) : existing.name;
  const type = 'type' in input ? viewType(input.type) : existing.type;
  const config = 'config' in input ? jsonObject(input.config) : parsedObject(existing.config_json);
  if (!name || !type || !config) return error('视图名称、类型或配置无效', 400);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE database_views SET name = ?, type = ?, config_json = ?, updated_at = ?
      WHERE id = ? AND database_id = ?`,
  )
    .bind(name, type, JSON.stringify(config), now, viewId, authorization.database.id)
    .run();
  const view = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_views WHERE id = ?`,
  )
    .bind(viewId)
    .first<ViewRecord>();
  if (!view) throw new Error('database_view_update_result_missing');
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.view.updated',
    'database_view',
    viewId,
    { type },
  );
  return json({ view: viewSummary(view) });
}

async function deleteView(
  env: Env,
  authorization: DatabaseAuthorization,
  viewId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能删除视图', 409);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM database_views WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) <= 1) return error('数据库至少需要一个视图', 409);
  const result = await env.DB.prepare('DELETE FROM database_views WHERE id = ? AND database_id = ?')
    .bind(viewId, authorization.database.id)
    .run();
  if (!result.meta.changes) return error('视图不存在', 404);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.view.deleted',
    'database_view',
    viewId,
  );
  return json({ ok: true });
}

async function databaseProperties(env: Env, databaseId: string): Promise<PropertyRecord[]> {
  return (
    await env.DB.prepare(
      `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
         FROM database_properties WHERE database_id = ? ORDER BY sort_order LIMIT ?`,
    )
      .bind(databaseId, MAX_DATABASE_PROPERTIES)
      .all<PropertyRecord>()
  ).results;
}

async function validateReferenceValues(
  env: Env,
  authorization: DatabaseAuthorization,
  actorId: string,
  property: PropertyRecord,
  value: JsonValue,
  rowPageId: string | null,
): Promise<string | null> {
  if (value === null) return null;
  if (property.type === 'person') {
    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    if (!ids.length) return null;
    const placeholders = ids.map(() => '?').join(', ');
    const result = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM organization_members
        WHERE organization_id = ? AND status = 'active' AND user_id IN (${placeholders})`,
    )
      .bind(authorization.database.organization_id, ...ids)
      .first<{ count: number }>();
    return Number(result?.count ?? 0) === ids.length ? null : '人员属性包含无效成员';
  }
  if (property.type === 'relation') {
    const targetDatabaseId = parsedObject(property.config_json).targetDatabaseId;
    if (typeof targetDatabaseId !== 'string') return '关系属性尚未配置目标数据库';
    const target = await authorizeDatabase(env, targetDatabaseId, actorId, 'view');
    if (!target || target.database.organization_id !== authorization.database.organization_id) {
      return '关系目标不存在或无权访问';
    }
    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    if (!ids.length) return null;
    const placeholders = ids.map(() => '?').join(', ');
    const targetRows = (
      await env.DB.prepare(
        `SELECT id, database_id, page_id, sort_key, sequence_number, created_by, updated_by,
                created_at, updated_at, archived_at
           FROM database_rows
          WHERE database_id = ? AND archived_at IS NULL AND id IN (${placeholders})`,
      )
        .bind(targetDatabaseId, ...ids)
        .all<RowRecord>()
    ).results;
    const visible = await visibleDatabaseRows(env, target, targetRows, actorId);
    return visible.length === ids.length ? null : '关系属性包含无权访问、无效或已归档的行';
  }
  if (property.type === 'files') {
    const ids = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string')
      : [];
    if (!ids.length) return null;
    if (!rowPageId) return '请先创建数据行，再上传并选择附件';
    const placeholders = ids.map(() => '?').join(', ');
    const result = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM attachments
        WHERE organization_id = ? AND page_id = ? AND status = 'ready'
          AND deleted_at IS NULL AND id IN (${placeholders})`,
    )
      .bind(authorization.database.organization_id, rowPageId, ...ids)
      .first<{ count: number }>();
    return Number(result?.count ?? 0) === ids.length ? null : '文件属性包含不属于此数据行的附件';
  }
  return null;
}

async function normalizedRowValues(
  env: Env,
  authorization: DatabaseAuthorization,
  actorId: string,
  input: unknown,
  rowPageId: string | null,
): Promise<{ values: Map<PropertyRecord, JsonValue> } | { error: string }> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    return { error: 'values 必须是对象' };
  const properties = await databaseProperties(env, authorization.database.id);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const values = new Map<PropertyRecord, JsonValue>();
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_DATABASE_PROPERTIES) return { error: '一次写入的属性过多' };
  for (const [propertyId, value] of entries) {
    const property = propertyById.get(propertyId);
    if (!property) return { error: '包含不存在的属性' };
    const normalized = normalizeDatabaseCellValue(property.type, value);
    if (!normalized.ok) return { error: `${property.name}：${normalized.error ?? '值无效'}` };
    const referenceError = await validateReferenceValues(
      env,
      authorization,
      actorId,
      property,
      normalized.value,
      rowPageId,
    );
    if (referenceError) return { error: `${property.name}：${referenceError}` };
    values.set(property, normalized.value);
  }
  return { values };
}

function titleFromValues(values: ReadonlyMap<PropertyRecord, JsonValue>): string {
  for (const [property, value] of values) {
    if (property.type === 'title' && typeof value === 'string' && value.trim()) {
      return value.trim().slice(0, 200);
    }
  }
  return '未命名';
}

function cellStatements(
  env: Env,
  database: DatabaseRecord,
  rowId: string,
  actorId: string,
  now: number,
  values: ReadonlyMap<PropertyRecord, JsonValue>,
): D1PreparedStatement[] {
  return [...values].map(([property, value]) =>
    env.DB.prepare(
      `INSERT INTO database_cells(
         organization_id, database_id, row_id, property_id, value_json, updated_by, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(row_id, property_id) DO UPDATE SET
         value_json = excluded.value_json,
         updated_by = excluded.updated_by,
         updated_at = excluded.updated_at`,
    ).bind(
      database.organization_id,
      database.id,
      rowId,
      property.id,
      JSON.stringify(value),
      actorId,
      now,
    ),
  );
}

function relationEdgeStatements(
  env: Env,
  database: DatabaseRecord,
  rowId: string,
  actorId: string,
  now: number,
  values: ReadonlyMap<PropertyRecord, JsonValue>,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const [property, value] of values) {
    if (property.type !== 'relation') continue;
    const relationConfig = parsedObject(property.config_json);
    const targetDatabaseId = relationConfig.targetDatabaseId;
    const syncedPropertyId = relationConfig.syncedPropertyId;
    if (typeof syncedPropertyId === 'string') {
      statements.push(
        env.DB.prepare(
          `UPDATE database_cells
              SET value_json = (
                    SELECT json_group_array(value)
                      FROM json_each(database_cells.value_json)
                     WHERE value <> ?
                  ),
                  updated_by = ?, updated_at = ?
            WHERE property_id = ? AND row_id IN (
              SELECT target_row_id FROM database_relation_edges
               WHERE source_row_id = ? AND source_property_id = ?
            )`,
        ).bind(rowId, actorId, now, syncedPropertyId, rowId, property.id),
        env.DB.prepare(
          `DELETE FROM database_relation_edges
            WHERE source_property_id = ? AND target_row_id = ?
              AND source_row_id IN (
                SELECT target_row_id FROM database_relation_edges
                 WHERE source_row_id = ? AND source_property_id = ?
              )`,
        ).bind(syncedPropertyId, rowId, rowId, property.id),
      );
    }
    statements.push(
      env.DB.prepare(
        'DELETE FROM database_relation_edges WHERE source_row_id = ? AND source_property_id = ?',
      ).bind(rowId, property.id),
    );
    if (typeof targetDatabaseId !== 'string' || !Array.isArray(value)) continue;
    for (const targetRowId of value) {
      if (typeof targetRowId !== 'string') continue;
      statements.push(
        env.DB.prepare(
          `INSERT INTO database_relation_edges(
             organization_id, source_database_id, source_row_id, source_property_id,
             target_database_id, target_row_id, created_by, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          database.organization_id,
          database.id,
          rowId,
          property.id,
          targetDatabaseId,
          targetRowId,
          actorId,
          now,
        ),
      );
      if (typeof syncedPropertyId === 'string') {
        statements.push(
          env.DB.prepare(
            `INSERT INTO database_cells(
               organization_id, database_id, row_id, property_id, value_json, updated_by, updated_at
             ) VALUES (?, ?, ?, ?, json_array(?), ?, ?)
             ON CONFLICT(row_id, property_id) DO UPDATE SET
               value_json = CASE
                 WHEN EXISTS (
                   SELECT 1 FROM json_each(database_cells.value_json) WHERE value = ?
                 ) THEN database_cells.value_json
                 ELSE json_insert(database_cells.value_json, '$[#]', ?)
               END,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          ).bind(
            database.organization_id,
            targetDatabaseId,
            targetRowId,
            syncedPropertyId,
            rowId,
            actorId,
            now,
            rowId,
            rowId,
          ),
          env.DB.prepare(
            `INSERT INTO database_relation_edges(
               organization_id, source_database_id, source_row_id, source_property_id,
               target_database_id, target_row_id, created_by, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(source_row_id, source_property_id, target_row_id) DO NOTHING`,
          ).bind(
            database.organization_id,
            targetDatabaseId,
            targetRowId,
            syncedPropertyId,
            database.id,
            rowId,
            actorId,
            now,
          ),
        );
      }
    }
  }
  return statements;
}

async function cleanupCreatedRow(
  env: Env,
  authorization: DatabaseAuthorization,
  row: DatabaseRowSummary,
  properties: readonly PropertyRecord[],
  actorId: string,
): Promise<void> {
  const copiedObjects = (
    await env.DB.prepare('SELECT r2_key FROM attachments WHERE page_id = ?')
      .bind(row.pageId)
      .all<{ r2_key: string }>()
  ).results;
  const emptyRelations = new Map<PropertyRecord, JsonValue>(
    properties.filter((property) => property.type === 'relation').map((property) => [property, []]),
  );
  await env.DB.batch([
    ...relationEdgeStatements(
      env,
      authorization.database,
      row.id,
      actorId,
      Date.now(),
      emptyRelations,
    ),
    env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(row.pageId),
    env.DB.prepare('DELETE FROM attachments WHERE page_id = ?').bind(row.pageId),
    env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(row.pageId),
  ]);
  await Promise.all(copiedObjects.map((object) => env.ATTACHMENTS.delete(object.r2_key)));
}

async function webhookSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
  );
  return [...signature].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function safeWebhookUrl(raw: JsonValue | undefined): URL | null {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:' ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host === '::1'
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

async function runDatabaseAutomationAction(
  env: Env,
  authorization: DatabaseAuthorization,
  automation: AutomationRecord,
  rowId: string,
  triggerType: DatabaseAutomationTrigger,
  _actor: AuthUserSummary,
): Promise<number | null> {
  const config = parsedObject(automation.action_config_json);
  const executionActorRow = await env.DB.prepare(
    `SELECT id, email, display_name, avatar_url FROM users WHERE id = ? AND status = 'active'`,
  )
    .bind(automation.created_by)
    .first<{ id: string; email: string; display_name: string; avatar_url: string | null }>();
  const executionAuthorization = await authorizeDatabase(
    env,
    authorization.database.id,
    automation.created_by,
    'edit_content',
  );
  if (!executionActorRow || !executionAuthorization) {
    throw new Error('自动化创建者已无权编辑数据库');
  }
  const executionActor: AuthUserSummary = {
    id: executionActorRow.id,
    email: executionActorRow.email,
    displayName: executionActorRow.display_name,
    avatarUrl: executionActorRow.avatar_url,
  };
  if (automation.action_type === 'webhook') {
    const url = safeWebhookUrl(config.url);
    if (!url) throw new Error('Webhook 必须是可公开访问的 HTTPS 地址');
    const current = await snapshot(env, executionAuthorization, automation.created_by);
    const row = current.rows.find((candidate) => candidate.id === rowId);
    if (!row) throw new Error('自动化创建者已无权读取目标记录');
    const body = JSON.stringify({
      event: triggerType,
      automationId: automation.id,
      databaseId: authorization.database.id,
      row,
      occurredAt: Date.now(),
    });
    const headers = new Headers({
      'content-type': 'application/json',
      'user-agent': 'Rdocs-Automation/1.0',
      'x-rdocs-event': triggerType,
    });
    if (typeof config.secret === 'string' && config.secret.length >= 16) {
      headers.set('x-rdocs-signature-256', `sha256=${await webhookSignature(config.secret, body)}`);
    }
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Webhook 返回 ${response.status}`);
    return response.status;
  }
  const targetPropertyId =
    typeof config.targetPropertyId === 'string' ? config.targetPropertyId : '';
  let values: Record<string, JsonValue> = {};
  if (automation.action_type === 'archive_row') {
    const response = await updateRow(
      new Request('https://rdocs.internal/api/automation-archive', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: {}, archived: true }),
      }),
      env,
      executionAuthorization,
      rowId,
      executionActor,
      { skipAutomations: true },
    );
    if (!response.ok) throw new Error('自动化无法归档记录');
    return null;
  }
  const target = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_properties WHERE id = ? AND database_id = ?`,
  )
    .bind(targetPropertyId, authorization.database.id)
    .first<PropertyRecord>();
  if (!target || isComputedDatabaseProperty(target.type) || target.type === 'button') {
    throw new Error('自动化目标属性无效');
  }
  if (automation.action_type === 'set_property') {
    values = { [target.id]: config.value ?? null };
  } else {
    const cell = await env.DB.prepare(
      'SELECT value_json FROM database_cells WHERE row_id = ? AND property_id = ?',
    )
      .bind(rowId, target.id)
      .first<{ value_json: string }>();
    const current = parsedValue(cell?.value_json ?? 'null');
    if (automation.action_type === 'toggle_checkbox' && target.type === 'checkbox') {
      values = { [target.id]: current !== true };
    } else if (automation.action_type === 'increment_number' && target.type === 'number') {
      const increment = typeof config.increment === 'number' ? config.increment : 1;
      values = { [target.id]: (typeof current === 'number' ? current : 0) + increment };
    } else {
      throw new Error('自动化动作与目标属性不匹配');
    }
  }
  const response = await updateRow(
    new Request('https://rdocs.internal/api/automation-update', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
    env,
    executionAuthorization,
    rowId,
    executionActor,
    { skipAutomations: true },
  );
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(payload?.error ?? '自动化属性写入失败');
  }
  return null;
}

async function runDatabaseAutomations(
  env: Env,
  authorization: DatabaseAuthorization,
  rowId: string,
  triggerType: Exclude<DatabaseAutomationTrigger, 'manual'>,
  actor: AuthUserSummary,
  propertyIds: readonly string[] = [],
): Promise<void> {
  const triggerTypes =
    triggerType === 'row_updated' ? ['row_updated', 'property_changed'] : [triggerType];
  const placeholders = triggerTypes.map(() => '?').join(', ');
  const automations = (
    await env.DB.prepare(
      `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
              action_type, action_config_json, created_by, updated_by, created_at, updated_at
         FROM database_automations
        WHERE database_id = ? AND enabled = 1 AND trigger_type IN (${placeholders})
        ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(authorization.database.id, ...triggerTypes, MAX_DATABASE_AUTOMATIONS)
      .all<AutomationRecord>()
  ).results.filter((automation) => {
    if (automation.trigger_type !== 'property_changed') return true;
    const propertyId = parsedObject(automation.trigger_config_json).propertyId;
    return typeof propertyId === 'string' && propertyIds.includes(propertyId);
  });
  const eventKey = crypto.randomUUID();
  for (const automation of automations) {
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    const inserted = await env.DB.prepare(
      `INSERT INTO database_automation_runs(
         id, organization_id, database_id, automation_id, row_id, event_key,
         trigger_type, status, attempt, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, ?)
       ON CONFLICT(automation_id, event_key) DO NOTHING`,
    )
      .bind(
        runId,
        authorization.database.organization_id,
        authorization.database.id,
        automation.id,
        rowId,
        eventKey,
        triggerType,
        startedAt,
      )
      .run();
    if (!inserted.meta.changes) continue;
    try {
      const condition = parsedObject(automation.trigger_config_json).condition;
      if (condition && typeof condition === 'object' && !Array.isArray(condition)) {
        const cells = (
          await env.DB.prepare(
            'SELECT property_id, value_json FROM database_cells WHERE row_id = ?',
          )
            .bind(rowId)
            .all<{ property_id: string; value_json: string }>()
        ).results;
        const values: Record<string, JsonValue> = {};
        for (const cell of cells) values[cell.property_id] = parsedValue(cell.value_json);
        const propertyId = (condition as Record<string, JsonValue>).propertyId;
        const op = (condition as Record<string, JsonValue>).op;
        const expected = (condition as Record<string, JsonValue>).value;
        const current = typeof propertyId === 'string' ? values[propertyId] : undefined;
        const matches =
          op === 'is_empty'
            ? current === null || current === undefined || current === '' || current === false
            : op === 'not_empty'
              ? !(current === null || current === undefined || current === '' || current === false)
              : op === 'neq'
                ? JSON.stringify(current) !== JSON.stringify(expected ?? null)
                : op === 'contains'
                  ? typeof current === 'string' && typeof expected === 'string'
                    ? current.includes(expected)
                    : Array.isArray(current) && current.includes(expected as never)
                  : JSON.stringify(current) === JSON.stringify(expected ?? null);
        if (!matches) {
          await env.DB.prepare(
            `UPDATE database_automation_runs
                SET status = 'skipped', completed_at = ? WHERE id = ?`,
          )
            .bind(Date.now(), runId)
            .run();
          continue;
        }
      }
      const extraSteps = parsedObject(automation.action_config_json).steps;
      if (Array.isArray(extraSteps)) {
        for (const step of extraSteps) {
          if (!step || typeof step !== 'object' || Array.isArray(step)) continue;
          const stepType = (step as Record<string, JsonValue>).type;
          const stepConfig = (step as Record<string, JsonValue>).config;
          if (typeof stepType !== 'string' || !AUTOMATION_ACTIONS.has(stepType as never)) continue;
          await runDatabaseAutomationAction(
            env,
            authorization,
            {
              ...automation,
              action_type: stepType as DatabaseAutomationAction,
              action_config_json: JSON.stringify(
                stepConfig && typeof stepConfig === 'object' && !Array.isArray(stepConfig)
                  ? stepConfig
                  : {},
              ),
            },
            rowId,
            triggerType,
            actor,
          );
        }
      }
      const responseCode = await runDatabaseAutomationAction(
        env,
        authorization,
        automation,
        rowId,
        triggerType,
        actor,
      );
      await env.DB.prepare(
        `UPDATE database_automation_runs
            SET status = 'succeeded', response_code = ?, completed_at = ? WHERE id = ?`,
      )
        .bind(responseCode, Date.now(), runId)
        .run();
    } catch (reason) {
      await env.DB.prepare(
        `UPDATE database_automation_runs
            SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`,
      )
        .bind(
          (reason instanceof Error ? reason.message : '自动化执行失败').slice(0, 500),
          Date.now(),
          runId,
        )
        .run();
    }
  }
}

async function validateAutomationConfiguration(
  env: Env,
  databaseId: string,
  triggerType: DatabaseAutomationTrigger,
  triggerConfig: Record<string, JsonValue>,
  actionType: DatabaseAutomationAction,
  actionConfig: Record<string, JsonValue>,
): Promise<string | null> {
  if (triggerType === 'property_changed') {
    const propertyId = triggerConfig.propertyId;
    if (typeof propertyId !== 'string') return '请选择触发属性';
    const property = await env.DB.prepare(
      'SELECT 1 AS found FROM database_properties WHERE id = ? AND database_id = ?',
    )
      .bind(propertyId, databaseId)
      .first<{ found: number }>();
    if (!property) return '触发属性不存在';
  }
  if (actionType === 'webhook') {
    if (!safeWebhookUrl(actionConfig.url)) return 'Webhook 必须是可公开访问的 HTTPS 地址';
    if (
      actionConfig.secret !== undefined &&
      (typeof actionConfig.secret !== 'string' || actionConfig.secret.length < 16)
    ) {
      return 'Webhook 签名密钥至少需要 16 个字符';
    }
    return null;
  }
  if (actionType === 'archive_row') return null;
  const targetPropertyId = actionConfig.targetPropertyId;
  if (typeof targetPropertyId !== 'string') return '请选择目标属性';
  const target = await env.DB.prepare(
    'SELECT type FROM database_properties WHERE id = ? AND database_id = ?',
  )
    .bind(targetPropertyId, databaseId)
    .first<{ type: DatabasePropertyType }>();
  if (!target || isComputedDatabaseProperty(target.type) || target.type === 'button') {
    return '目标属性不存在或不可写';
  }
  if (actionType === 'toggle_checkbox' && target.type !== 'checkbox') {
    return '切换动作只能用于复选框';
  }
  if (actionType === 'increment_number' && target.type !== 'number') {
    return '递增动作只能用于数字属性';
  }
  if (actionType === 'set_property') {
    const normalized = normalizeDatabaseCellValue(target.type, actionConfig.value ?? null);
    return normalized.ok ? null : (normalized.error ?? '自动化设置值无效');
  }
  return null;
}

async function listDatabaseAutomations(
  env: Env,
  authorization: DatabaseAuthorization,
): Promise<Response> {
  const [automations, runs] = await Promise.all([
    env.DB.prepare(
      `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
              action_type, action_config_json, created_by, updated_by, created_at, updated_at
         FROM database_automations WHERE database_id = ? ORDER BY created_at ASC LIMIT ?`,
    )
      .bind(authorization.database.id, MAX_DATABASE_AUTOMATIONS)
      .all<AutomationRecord>(),
    env.DB.prepare(
      `SELECT id, database_id, automation_id, row_id, trigger_type, status, attempt,
              response_code, error_message, started_at, completed_at
         FROM database_automation_runs WHERE database_id = ?
        ORDER BY started_at DESC LIMIT 100`,
    )
      .bind(authorization.database.id)
      .all<AutomationRunRecord>(),
  ]);
  return json({
    automations: automations.results.map(automationSummary),
    runs: runs.results.map(automationRunSummary),
  });
}

async function createDatabaseAutomation(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能创建自动化', 409);
  const input = await requestBody(request);
  const name = entityName(input?.name, 100);
  const triggerType = input?.triggerType;
  const actionType = input?.actionType;
  const triggerConfig = jsonObject(input?.triggerConfig ?? {});
  const actionConfig = jsonObject(input?.actionConfig ?? {});
  if (!name) return error('自动化名称无效', 400);
  if (typeof triggerType !== 'string' || !AUTOMATION_TRIGGERS.has(triggerType as never)) {
    return error('自动化触发器无效', 400);
  }
  if (typeof actionType !== 'string' || !AUTOMATION_ACTIONS.has(actionType as never)) {
    return error('自动化动作无效', 400);
  }
  if (!triggerConfig || !actionConfig) return error('自动化配置无效', 400);
  const configurationError = await validateAutomationConfiguration(
    env,
    authorization.database.id,
    triggerType as DatabaseAutomationTrigger,
    triggerConfig,
    actionType as DatabaseAutomationAction,
    actionConfig,
  );
  if (configurationError) return error(configurationError, 400);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM database_automations WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_DATABASE_AUTOMATIONS) {
    return error('自动化数量已达上限', 409);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  try {
    await env.DB.prepare(
      `INSERT INTO database_automations(
         id, organization_id, database_id, name, enabled, trigger_type, trigger_config_json,
         action_type, action_config_json, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        authorization.database.organization_id,
        authorization.database.id,
        name,
        triggerType,
        JSON.stringify(triggerConfig),
        actionType,
        JSON.stringify(actionConfig),
        actor.id,
        actor.id,
        now,
        now,
      )
      .run();
  } catch {
    return error('已有同名自动化', 409);
  }
  const automation = await env.DB.prepare(
    `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
            action_type, action_config_json, created_by, updated_by, created_at, updated_at
       FROM database_automations WHERE id = ?`,
  )
    .bind(id)
    .first<AutomationRecord>();
  if (!automation) return error('自动化创建失败', 500);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.automation.created',
    'database',
    authorization.database.id,
    { automationId: id },
  );
  const cron = typeof triggerConfig.cron === 'string' ? triggerConfig.cron.trim() : '';
  const nextRun = cron ? parseSimpleCron(cron, now) : null;
  if (nextRun) {
    await env.DB.prepare(
      `INSERT INTO scheduled_jobs(
         id, organization_id, kind, payload_json, run_at, status, attempts, created_at
       ) VALUES (?, ?, 'automation', ?, ?, 'pending', 0, ?)`,
    )
      .bind(
        crypto.randomUUID(),
        authorization.database.organization_id,
        JSON.stringify({
          automationId: id,
          cron,
          databaseId: authorization.database.id,
        }),
        nextRun,
        now,
      )
      .run();
  }
  return json({ automation: automationSummary(automation) }, { status: 201 });
}

async function updateDatabaseAutomation(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  automationId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能修改自动化', 409);
  const current = await env.DB.prepare(
    `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
            action_type, action_config_json, created_by, updated_by, created_at, updated_at
       FROM database_automations WHERE id = ? AND database_id = ?`,
  )
    .bind(automationId, authorization.database.id)
    .first<AutomationRecord>();
  if (!current) return error('自动化不存在', 404);
  const input = await requestBody(request);
  if (!input) return error('请求格式无效', 400);
  const name = input.name === undefined ? current.name : entityName(input.name, 100);
  const enabled = input.enabled === undefined ? Boolean(current.enabled) : input.enabled;
  if (!name || typeof enabled !== 'boolean') return error('自动化设置无效', 400);
  try {
    await env.DB.prepare(
      `UPDATE database_automations SET name = ?, enabled = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND database_id = ?`,
    )
      .bind(name, enabled ? 1 : 0, actor.id, Date.now(), automationId, authorization.database.id)
      .run();
  } catch {
    return error('已有同名自动化', 409);
  }
  const updated = await env.DB.prepare(
    `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
            action_type, action_config_json, created_by, updated_by, created_at, updated_at
       FROM database_automations WHERE id = ?`,
  )
    .bind(automationId)
    .first<AutomationRecord>();
  if (!updated) return error('自动化不存在', 404);
  return json({ automation: automationSummary(updated) });
}

async function deleteDatabaseAutomation(
  env: Env,
  authorization: DatabaseAuthorization,
  automationId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能删除自动化', 409);
  const result = await env.DB.prepare(
    'DELETE FROM database_automations WHERE id = ? AND database_id = ?',
  )
    .bind(automationId, authorization.database.id)
    .run();
  if (!result.meta.changes) return error('自动化不存在', 404);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.automation.deleted',
    'database',
    authorization.database.id,
    { automationId },
  );
  return json({ ok: true });
}

async function runManualDatabaseAutomation(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  automationId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const input = await requestBody(request);
  const rowId = typeof input?.rowId === 'string' ? input.rowId : '';
  if (!isPageId(rowId)) return error('请选择要运行自动化的记录', 400);
  const automation = await env.DB.prepare(
    `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
            action_type, action_config_json, created_by, updated_by, created_at, updated_at
       FROM database_automations
      WHERE id = ? AND database_id = ? AND enabled = 1 AND trigger_type = 'manual'`,
  )
    .bind(automationId, authorization.database.id)
    .first<AutomationRecord>();
  const row = await env.DB.prepare(
    'SELECT page_id FROM database_rows WHERE id = ? AND database_id = ? AND archived_at IS NULL',
  )
    .bind(rowId, authorization.database.id)
    .first<{ page_id: string }>();
  if (
    !automation ||
    !row ||
    !(await requirePageAction(env, row.page_id, actor.id, 'edit_content'))
  ) {
    return error('自动化或记录不存在，或无权运行', 404);
  }
  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  await env.DB.prepare(
    `INSERT INTO database_automation_runs(
       id, organization_id, database_id, automation_id, row_id, event_key,
       trigger_type, status, attempt, started_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'running', 1, ?)`,
  )
    .bind(
      runId,
      authorization.database.organization_id,
      authorization.database.id,
      automationId,
      rowId,
      crypto.randomUUID(),
      startedAt,
    )
    .run();
  try {
    const responseCode = await runDatabaseAutomationAction(
      env,
      authorization,
      automation,
      rowId,
      'manual',
      actor,
    );
    await env.DB.prepare(
      `UPDATE database_automation_runs
          SET status = 'succeeded', response_code = ?, completed_at = ? WHERE id = ?`,
    )
      .bind(responseCode, Date.now(), runId)
      .run();
  } catch (reason) {
    await env.DB.prepare(
      `UPDATE database_automation_runs
          SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`,
    )
      .bind(
        (reason instanceof Error ? reason.message : '自动化执行失败').slice(0, 500),
        Date.now(),
        runId,
      )
      .run();
  }
  const run = await env.DB.prepare(
    `SELECT id, database_id, automation_id, row_id, trigger_type, status, attempt,
            response_code, error_message, started_at, completed_at
       FROM database_automation_runs WHERE id = ?`,
  )
    .bind(runId)
    .first<AutomationRunRecord>();
  return run ? json({ run: automationRunSummary(run) }) : error('自动化运行记录丢失', 500);
}

export async function runScheduledAutomation(
  env: Env,
  input: { automationId: string; databaseId: string; rowId?: string | null },
): Promise<void> {
  if (!isPageId(input.automationId) || !isPageId(input.databaseId)) {
    throw new Error('定时自动化参数无效');
  }
  const automation = await env.DB.prepare(
    `SELECT id, database_id, name, enabled, trigger_type, trigger_config_json,
            action_type, action_config_json, created_by, updated_by, created_at, updated_at
       FROM database_automations WHERE id = ? AND database_id = ? AND enabled = 1`,
  )
    .bind(input.automationId, input.databaseId)
    .first<AutomationRecord>();
  if (!automation) throw new Error('自动化不存在或已停用');
  const authorization = await authorizeDatabase(
    env,
    input.databaseId,
    automation.created_by,
    'edit_content',
  );
  if (!authorization) throw new Error('自动化创建者已无权编辑数据库');
  const actorRow = await env.DB.prepare(
    `SELECT id, email, display_name, avatar_url FROM users WHERE id = ? AND status = 'active'`,
  )
    .bind(automation.created_by)
    .first<{ avatar_url: string | null; display_name: string; email: string; id: string }>();
  if (!actorRow) throw new Error('自动化创建者不可用');
  const actor: AuthUserSummary = {
    avatarUrl: actorRow.avatar_url,
    displayName: actorRow.display_name,
    email: actorRow.email,
    id: actorRow.id,
  };
  const current = await snapshot(env, authorization, actor.id);
  const condition = parsedObject(automation.trigger_config_json).condition;
  const conditionObject =
    condition && typeof condition === 'object' && !Array.isArray(condition)
      ? (condition as Record<string, JsonValue>)
      : null;
  const rows = input.rowId
    ? current.rows.filter((row) => row.id === input.rowId)
    : current.rows
        .filter((row) => automationConditionMatches(row.values, conditionObject))
        .slice(0, 20);
  if (!rows.length) return;
  for (const row of rows) {
    const runId = crypto.randomUUID();
    const startedAt = Date.now();
    await env.DB.prepare(
      `INSERT INTO database_automation_runs(
         id, organization_id, database_id, automation_id, row_id, event_key,
         trigger_type, status, attempt, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', 1, ?)`,
    )
      .bind(
        runId,
        authorization.database.organization_id,
        authorization.database.id,
        automation.id,
        row.id,
        `schedule:${automation.id}:${row.id}:${startedAt}`,
        automation.trigger_type,
        startedAt,
      )
      .run();
    try {
      const responseCode = await runDatabaseAutomationAction(
        env,
        authorization,
        automation,
        row.id,
        automation.trigger_type,
        actor,
      );
      await env.DB.prepare(
        `UPDATE database_automation_runs
            SET status = 'succeeded', response_code = ?, completed_at = ? WHERE id = ?`,
      )
        .bind(responseCode, Date.now(), runId)
        .run();
    } catch (reason) {
      await env.DB.prepare(
        `UPDATE database_automation_runs
            SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?`,
      )
        .bind(
          (reason instanceof Error ? reason.message : '自动化执行失败').slice(0, 500),
          Date.now(),
          runId,
        )
        .run();
    }
  }
}

async function createRow(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
  options: { triggerType?: 'row_created' | 'form_submitted' } = {},
): Promise<Response> {
  const input = (await requestBody(request)) ?? {};
  const normalized = await normalizedRowValues(
    env,
    authorization,
    actor.id,
    input.values ?? {},
    null,
  );
  if ('error' in normalized) return error(normalized.error, 400);
  const rowId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const now = Date.now();
  const title = titleFromValues(normalized.values);
  const sortKey = `${now.toString().padStart(20, '0')}:${rowId}`;
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO pages(
         id, organization_id, space_id, parent_id, title, sort_key,
         current_generation, editor_schema_version, created_by, updated_by, created_at, updated_at
       ) SELECT ?, d.organization_id, p.space_id, d.page_id, ?, ?, 1, ?, ?, ?, ?, ?
           FROM databases d JOIN pages p ON p.id = d.page_id WHERE d.id = ?`,
    ).bind(
      pageId,
      title,
      sortKey,
      EDITOR_SCHEMA_VERSION,
      actor.id,
      actor.id,
      now,
      now,
      authorization.database.id,
    ),
    env.DB.prepare(
      `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).bind(pageId, now),
    env.DB.prepare(
      `INSERT INTO page_search_projection(
         page_id, organization_id, space_id, generation, collab_seq, title, normalized_body, updated_at
       ) SELECT ?, d.organization_id, p.space_id, 1, 0, ?, '', ?
           FROM databases d JOIN pages p ON p.id = d.page_id WHERE d.id = ?`,
    ).bind(pageId, title, now, authorization.database.id),
    env.DB.prepare(
      'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
    ).bind(pageId, searchIndexText(title), searchIndexText(title)),
    env.DB.prepare(
      `INSERT INTO database_rows(
         id, organization_id, database_id, page_id, sort_key, sequence_number,
         created_by, updated_by, created_at, updated_at, archived_at
       ) SELECT ?, ?, ?, ?, ?, next_row_sequence, ?, ?, ?, ?, NULL
           FROM database_counters WHERE database_id = ?`,
    ).bind(
      rowId,
      authorization.database.organization_id,
      authorization.database.id,
      pageId,
      sortKey,
      actor.id,
      actor.id,
      now,
      now,
      authorization.database.id,
    ),
    env.DB.prepare(
      'UPDATE database_counters SET next_row_sequence = next_row_sequence + 1 WHERE database_id = ?',
    ).bind(authorization.database.id),
    ...cellStatements(env, authorization.database, rowId, actor.id, now, normalized.values),
    ...relationEdgeStatements(env, authorization.database, rowId, actor.id, now, normalized.values),
    env.DB.prepare('UPDATE databases SET updated_by = ?, updated_at = ? WHERE id = ?').bind(
      actor.id,
      now,
      authorization.database.id,
    ),
  ];
  await env.DB.batch(statements);
  await runDatabaseAutomations(
    env,
    authorization,
    rowId,
    options.triggerType ?? 'row_created',
    actor,
  );
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.row.created',
    'database_row',
    rowId,
    {
      pageId,
    },
  );
  const latest = await findDatabase(env, authorization.database.id);
  if (!latest) throw new Error('database_row_create_result_missing');
  const current = await snapshot(env, { database: latest, role: authorization.role }, actor.id);
  return json({ row: current.rows.find((row) => row.id === rowId) }, { status: 201 });
}

async function updateRow(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  rowId: string,
  actor: AuthUserSummary,
  options: { skipAutomations?: boolean } = {},
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, database_id, page_id, sort_key, sequence_number, created_by, updated_by,
            created_at, updated_at, archived_at
       FROM database_rows WHERE id = ? AND database_id = ?`,
  )
    .bind(rowId, authorization.database.id)
    .first<RowRecord>();
  if (!row) return error('数据行不存在', 404);
  if (!(await requirePageAction(env, row.page_id, actor.id, 'edit_content'))) {
    return error('数据行不存在或无权编辑', 404);
  }
  const input = await requestBody(request);
  if (!input) return error('请求格式无效', 400);
  const normalized = await normalizedRowValues(
    env,
    authorization,
    actor.id,
    input.values ?? {},
    row.page_id,
  );
  if ('error' in normalized) return error(normalized.error, 400);
  let archived: boolean | undefined;
  if ('archived' in input) {
    if (typeof input.archived !== 'boolean') return error('archived 必须是布尔值', 400);
    archived = input.archived;
  }
  if (!normalized.values.size && archived === undefined) return error('没有可更新的字段', 400);
  const titleProperty = [...normalized.values].find(([property]) => property.type === 'title');
  const title =
    titleProperty && typeof titleProperty[1] === 'string'
      ? (titleProperty[1].trim() || '未命名').slice(0, 200)
      : null;
  const now = Date.now();
  const clearedDateReminderStatements = [...normalized.values].flatMap(([property, value]) =>
    property.type === 'date' && value === null
      ? [
          env.DB.prepare(
            `UPDATE page_reminders
                SET status = 'cancelled', cancelled_at = ?, updated_at = ?
              WHERE page_id = ? AND source_type = 'database_date' AND source_id = ?
                AND status = 'scheduled'`,
          ).bind(now, now, row.page_id, `${authorization.database.id}:${rowId}:${property.id}`),
        ]
      : [],
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE database_rows SET updated_by = ?, updated_at = ?, archived_at = ?
        WHERE id = ? AND database_id = ?`,
    ).bind(
      actor.id,
      now,
      archived === undefined ? row.archived_at : archived ? now : null,
      rowId,
      authorization.database.id,
    ),
    ...cellStatements(env, authorization.database, rowId, actor.id, now, normalized.values),
    ...relationEdgeStatements(env, authorization.database, rowId, actor.id, now, normalized.values),
    ...clearedDateReminderStatements,
    env.DB.prepare('UPDATE databases SET updated_by = ?, updated_at = ? WHERE id = ?').bind(
      actor.id,
      now,
      authorization.database.id,
    ),
  ];
  if (archived) {
    statements.push(
      env.DB.prepare(
        `UPDATE page_reminders
            SET status = 'cancelled', cancelled_at = ?, updated_at = ?
          WHERE page_id = ? AND source_type = 'database_date' AND status = 'scheduled'`,
      ).bind(now, now, row.page_id),
    );
  }
  if (title !== null) {
    statements.push(
      env.DB.prepare(
        'UPDATE pages SET title = ?, updated_by = ?, updated_at = ? WHERE id = ?',
      ).bind(title, actor.id, now, row.page_id),
      env.DB.prepare(
        'UPDATE page_search_projection SET title = ?, updated_at = ? WHERE page_id = ?',
      ).bind(title, now, row.page_id),
      env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(row.page_id),
      env.DB.prepare(
        `INSERT INTO page_search_fts(page_id, title, normalized_body)
         SELECT page_id, ?, normalized_body FROM page_search_projection WHERE page_id = ?`,
      ).bind(searchIndexText(title), row.page_id),
    );
  }
  await env.DB.batch(statements);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.row.updated',
    'database_row',
    rowId,
    {
      properties: [...normalized.values.keys()].map((property) => property.id),
      ...(archived === undefined ? {} : { archived }),
    },
  );
  if (!options.skipAutomations && !archived) {
    await runDatabaseAutomations(
      env,
      authorization,
      rowId,
      'row_updated',
      actor,
      [...normalized.values.keys()].map((property) => property.id),
    );
  }
  if (archived) return json({ ok: true, archived: true });
  const latest = await findDatabase(env, authorization.database.id);
  if (!latest) throw new Error('database_row_update_result_missing');
  const current = await snapshot(env, { database: latest, role: authorization.role }, actor.id);
  return json({ row: current.rows.find((candidate) => candidate.id === rowId) });
}

async function duplicateRow(
  env: Env,
  authorization: DatabaseAuthorization,
  rowId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const row = await env.DB.prepare(
    `SELECT id, database_id, page_id, sort_key, sequence_number, created_by, updated_by,
            created_at, updated_at, archived_at
       FROM database_rows WHERE id = ? AND database_id = ? AND archived_at IS NULL`,
  )
    .bind(rowId, authorization.database.id)
    .first<RowRecord>();
  if (!row || !(await requirePageAction(env, row.page_id, actor.id, 'view'))) {
    return error('数据行不存在或无权复制', 404);
  }
  const sourcePage = await env.DB.prepare(
    'SELECT current_generation FROM pages WHERE id = ? AND deleted_at IS NULL',
  )
    .bind(row.page_id)
    .first<{ current_generation: number }>();
  if (!sourcePage) return error('数据行正文不存在', 404);
  const cells = (
    await env.DB.prepare(
      `SELECT c.row_id, c.property_id, c.value_json
         FROM database_cells c JOIN database_properties p ON p.id = c.property_id
        WHERE c.database_id = ? AND c.row_id = ?
          AND p.type NOT IN (
            'formula', 'rollup', 'created_time', 'created_by', 'last_edited_time',
            'last_edited_by', 'button', 'unique_id'
          )`,
    )
      .bind(authorization.database.id, rowId)
      .all<CellRecord>()
  ).results;
  const properties = await databaseProperties(env, authorization.database.id);
  const propertyById = new Map(properties.map((property) => [property.id, property]));
  const title = properties.find((property) => property.type === 'title');
  const sourceValues = Object.fromEntries(
    cells.map((cell) => [cell.property_id, parsedValue(cell.value_json)]),
  ) as Record<string, JsonValue>;
  const values = Object.fromEntries(
    Object.entries(sourceValues).filter(
      ([propertyId]) => propertyById.get(propertyId)?.type !== 'files',
    ),
  ) as Record<string, JsonValue>;
  if (title && typeof values[title.id] === 'string') {
    values[title.id] = `${values[title.id]} 副本`.slice(0, 2_000);
  }
  const createdResponse = await createRow(
    new Request('https://rdocs.internal/api/database-row-duplicate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values }),
    }),
    env,
    authorization,
    actor,
  );
  if (!createdResponse.ok) return createdResponse;
  const createdPayload = (await createdResponse.clone().json()) as { row?: DatabaseRowSummary };
  if (!createdPayload.row) return error('数据行副本创建失败', 500);
  const duplicate = createdPayload.row;
  try {
    const attachmentIds = await copyPageContent(env, {
      organizationId: authorization.database.organization_id,
      sourcePageId: row.page_id,
      sourceGeneration: Number(sourcePage.current_generation),
      targetPageId: duplicate.pageId,
      actorId: actor.id,
    });
    const fileValues = Object.fromEntries(
      Object.entries(sourceValues).flatMap(([propertyId, value]) => {
        if (propertyById.get(propertyId)?.type !== 'files' || !Array.isArray(value)) return [];
        return [
          [
            propertyId,
            value.flatMap((attachmentId) =>
              typeof attachmentId === 'string' && attachmentIds.has(attachmentId)
                ? [attachmentIds.get(attachmentId)!]
                : [],
            ),
          ],
        ];
      }),
    );
    const finalResponse = Object.keys(fileValues).length
      ? await updateRow(
          new Request('https://rdocs.internal/api/database-row-copy-files', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values: fileValues }),
          }),
          env,
          authorization,
          duplicate.id,
          actor,
        )
      : createdResponse;
    if (!finalResponse.ok) throw new PageContentCopyError('记录副本的文件属性初始化失败');
    await databaseAudit(
      env,
      authorization.database,
      actor.id,
      'database.row.duplicated',
      'database_row',
      duplicate.id,
      { sourceRowId: rowId, attachmentCount: attachmentIds.size },
    );
    return finalResponse;
  } catch (reason) {
    await cleanupCreatedRow(env, authorization, duplicate, properties, actor.id);
    return reason instanceof PageContentCopyError
      ? error(reason.message, reason.status)
      : error('数据行副本正文或附件复制失败', 500);
  }
}

async function executeDatabaseButton(
  env: Env,
  authorization: DatabaseAuthorization,
  rowId: string,
  propertyId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const [row, property] = await Promise.all([
    env.DB.prepare(
      `SELECT id, database_id, page_id, sort_key, sequence_number, created_by, updated_by,
              created_at, updated_at, archived_at
         FROM database_rows WHERE id = ? AND database_id = ? AND archived_at IS NULL`,
    )
      .bind(rowId, authorization.database.id)
      .first<RowRecord>(),
    env.DB.prepare(
      `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
         FROM database_properties WHERE id = ? AND database_id = ? AND type = 'button'`,
    )
      .bind(propertyId, authorization.database.id)
      .first<PropertyRecord>(),
  ]);
  if (!row || !property || !(await requirePageAction(env, row.page_id, actor.id, 'edit_content'))) {
    return error('按钮或记录不存在，或无权执行', 404);
  }
  const config = parsedObject(property.config_json);
  const action = typeof config.action === 'string' ? config.action : '';
  let response: Response;
  if (action === 'duplicate_row') {
    response = await duplicateRow(env, authorization, rowId, actor);
  } else if (action === 'archive_row') {
    response = await updateRow(
      new Request('https://rdocs.internal/api/database-button-archive', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: {}, archived: true }),
      }),
      env,
      authorization,
      rowId,
      actor,
    );
  } else if (action === 'open_url') {
    if (typeof config.url !== 'string') return error('按钮链接尚未配置', 409);
    try {
      const url = new URL(config.url);
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('invalid_protocol');
      response = json({ ok: true, openUrl: url.toString() });
    } catch {
      return error('按钮链接无效，只允许 HTTP 或 HTTPS', 400);
    }
  } else {
    const targetPropertyId =
      typeof config.targetPropertyId === 'string' ? config.targetPropertyId : '';
    const target = await env.DB.prepare(
      `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
         FROM database_properties WHERE id = ? AND database_id = ?`,
    )
      .bind(targetPropertyId, authorization.database.id)
      .first<PropertyRecord>();
    if (!target || isComputedDatabaseProperty(target.type) || target.type === 'button') {
      return error('按钮目标属性无效', 409);
    }
    let value: JsonValue;
    if (action === 'toggle_checkbox' && target.type === 'checkbox') {
      const current = await env.DB.prepare(
        'SELECT value_json FROM database_cells WHERE row_id = ? AND property_id = ?',
      )
        .bind(rowId, target.id)
        .first<{ value_json: string }>();
      value = parsedValue(current?.value_json ?? 'false') !== true;
    } else if (action === 'set_date_now' && target.type === 'date') {
      value = new Date().toISOString();
    } else if (action === 'increment_number' && target.type === 'number') {
      const current = await env.DB.prepare(
        'SELECT value_json FROM database_cells WHERE row_id = ? AND property_id = ?',
      )
        .bind(rowId, target.id)
        .first<{ value_json: string }>();
      const previous = parsedValue(current?.value_json ?? '0');
      const increment = typeof config.increment === 'number' ? config.increment : 1;
      value = (typeof previous === 'number' ? previous : 0) + increment;
    } else if (action === 'set_property') {
      value = config.value ?? null;
    } else {
      return error('按钮动作与目标属性不匹配', 409);
    }
    response = await updateRow(
      new Request('https://rdocs.internal/api/database-button-update', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ values: { [target.id]: value } }),
      }),
      env,
      authorization,
      rowId,
      actor,
    );
  }
  if (response.ok) {
    await databaseAudit(
      env,
      authorization.database,
      actor.id,
      'database.button.executed',
      'database_row',
      rowId,
      { propertyId, action },
    );
  }
  return response;
}

async function createDatabaseTemplate(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能创建模板', 409);
  const input = await requestBody(request);
  const name = entityName(input?.name, 100);
  const description =
    typeof input?.description === 'string' ? input.description.trim().slice(0, 500) : '';
  const sourceRowId = typeof input?.sourceRowId === 'string' ? input.sourceRowId : '';
  if (!name) return error('模板名称无效', 400);
  if (!isPageId(sourceRowId)) return error('请选择用于创建模板的记录', 400);
  const count = await env.DB.prepare(
    'SELECT COUNT(*) AS count FROM database_templates WHERE database_id = ?',
  )
    .bind(authorization.database.id)
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_DATABASE_TEMPLATES) return error('模板数量已达上限', 409);
  const existing = await env.DB.prepare(
    'SELECT 1 AS found FROM database_templates WHERE database_id = ? AND name = ?',
  )
    .bind(authorization.database.id, name)
    .first<{ found: number }>();
  if (existing) return error('已有同名模板', 409);
  const source = await env.DB.prepare(
    `SELECT r.id, r.page_id, p.current_generation
       FROM database_rows r JOIN pages p ON p.id = r.page_id
      WHERE r.id = ? AND r.database_id = ? AND r.archived_at IS NULL AND p.deleted_at IS NULL`,
  )
    .bind(sourceRowId, authorization.database.id)
    .first<{ id: string; page_id: string; current_generation: number }>();
  if (!source || !(await requirePageAction(env, source.page_id, actor.id, 'view'))) {
    return error('源记录不存在或无权读取', 404);
  }
  const cells = (
    await env.DB.prepare(
      `SELECT c.row_id, c.property_id, c.value_json
         FROM database_cells c JOIN database_properties p ON p.id = c.property_id
        WHERE c.database_id = ? AND c.row_id = ?
          AND p.type NOT IN (
            'formula', 'rollup', 'created_time', 'created_by', 'last_edited_time',
            'last_edited_by', 'button', 'unique_id'
          )`,
    )
      .bind(authorization.database.id, sourceRowId)
      .all<CellRecord>()
  ).results;
  const candidateValues = Object.fromEntries(
    cells.map((cell) => [cell.property_id, parsedValue(cell.value_json)]),
  ) as Record<string, JsonValue>;
  const normalized = await normalizedRowValues(
    env,
    authorization,
    actor.id,
    candidateValues,
    source.page_id,
  );
  if ('error' in normalized) return error(`源记录无法用于模板：${normalized.error}`, 400);
  const values = Object.fromEntries(
    [...normalized.values].map(([property, value]) => [property.id, value]),
  ) as Record<string, JsonValue>;
  const templateId = crypto.randomUUID();
  const pageId = crypto.randomUUID();
  const now = Date.now();
  const isDefault = input?.isDefault === true || Number(count?.count ?? 0) === 0;
  const statements: D1PreparedStatement[] = [];
  statements.push(
    env.DB.prepare(
      `INSERT INTO pages(
         id, organization_id, space_id, parent_id, title, sort_key,
         current_generation, editor_schema_version, created_by, updated_by, created_at, updated_at
       ) SELECT ?, d.organization_id, p.space_id, d.page_id, ?, ?, 1, ?, ?, ?, ?, ?
           FROM databases d JOIN pages p ON p.id = d.page_id WHERE d.id = ?`,
    ).bind(
      pageId,
      `模板 · ${name}`,
      `template:${now.toString().padStart(20, '0')}:${templateId}`,
      EDITOR_SCHEMA_VERSION,
      actor.id,
      actor.id,
      now,
      now,
      authorization.database.id,
    ),
    env.DB.prepare(
      `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
       VALUES (?, 1, 1, ?)`,
    ).bind(pageId, now),
    env.DB.prepare(
      `INSERT INTO page_search_projection(
         page_id, organization_id, space_id, generation, collab_seq, title, normalized_body, updated_at
       ) SELECT ?, d.organization_id, p.space_id, 1, 0, ?, '', ?
           FROM databases d JOIN pages p ON p.id = d.page_id WHERE d.id = ?`,
    ).bind(pageId, `模板 · ${name}`, now, authorization.database.id),
    env.DB.prepare(
      'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
    ).bind(pageId, searchIndexText(`模板 · ${name}`), searchIndexText(`模板 · ${name}`)),
    env.DB.prepare(
      `INSERT INTO database_templates(
         id, organization_id, database_id, page_id, name, description, values_json,
         is_default, created_by, updated_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)`,
    ).bind(
      templateId,
      authorization.database.organization_id,
      authorization.database.id,
      pageId,
      name,
      description,
      0,
      actor.id,
      actor.id,
      now,
      now,
    ),
  );
  await env.DB.batch(statements);
  try {
    const attachmentIds = await copyPageContent(env, {
      organizationId: authorization.database.organization_id,
      sourcePageId: source.page_id,
      sourceGeneration: Number(source.current_generation),
      targetPageId: pageId,
      actorId: actor.id,
    });
    const properties = await databaseProperties(env, authorization.database.id);
    const typeById = new Map(properties.map((property) => [property.id, property.type]));
    const templateValues = Object.fromEntries(
      Object.entries(values).map(([propertyId, value]) => [
        propertyId,
        typeById.get(propertyId) === 'files' && Array.isArray(value)
          ? value.flatMap((attachmentId) =>
              typeof attachmentId === 'string' && attachmentIds.has(attachmentId)
                ? [attachmentIds.get(attachmentId)!]
                : [],
            )
          : value,
      ]),
    );
    await env.DB.prepare(
      'UPDATE database_templates SET values_json = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    )
      .bind(JSON.stringify(templateValues), actor.id, Date.now(), templateId)
      .run();
    if (isDefault) {
      const defaultedAt = Date.now();
      await env.DB.batch([
        env.DB.prepare(
          'UPDATE database_templates SET is_default = 0, updated_by = ?, updated_at = ? WHERE database_id = ?',
        ).bind(actor.id, defaultedAt, authorization.database.id),
        env.DB.prepare(
          'UPDATE database_templates SET is_default = 1, updated_by = ?, updated_at = ? WHERE id = ?',
        ).bind(actor.id, defaultedAt, templateId),
      ]);
    }
  } catch (reason) {
    const objects = (
      await env.DB.prepare('SELECT r2_key FROM attachments WHERE page_id = ?')
        .bind(pageId)
        .all<{ r2_key: string }>()
    ).results;
    await env.DB.batch([
      env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(pageId),
      env.DB.prepare('DELETE FROM attachments WHERE page_id = ?').bind(pageId),
      env.DB.prepare('DELETE FROM pages WHERE id = ?').bind(pageId),
    ]);
    await Promise.all(objects.map((object) => env.ATTACHMENTS.delete(object.r2_key)));
    return reason instanceof PageContentCopyError
      ? error(reason.message, reason.status)
      : error('数据库模板创建失败', 500);
  }
  const template = await env.DB.prepare(
    `SELECT id, database_id, page_id, name, description, values_json, is_default,
            created_by, updated_by, created_at, updated_at
       FROM database_templates WHERE id = ?`,
  )
    .bind(templateId)
    .first<TemplateRecord>();
  if (!template) return error('数据库模板创建失败', 500);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.template.created',
    'database_template',
    templateId,
    { sourceRowId },
  );
  return json({ template: templateSummary(template, true) }, { status: 201 });
}

async function updateDatabaseTemplate(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  templateId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能修改模板', 409);
  const current = await env.DB.prepare(
    `SELECT id, database_id, page_id, name, description, values_json, is_default,
            created_by, updated_by, created_at, updated_at
       FROM database_templates WHERE id = ? AND database_id = ?`,
  )
    .bind(templateId, authorization.database.id)
    .first<TemplateRecord>();
  if (!current) return error('模板不存在', 404);
  const input = await requestBody(request);
  if (!input) return error('请求格式无效', 400);
  const name = input.name === undefined ? current.name : entityName(input.name, 100);
  if (!name) return error('模板名称无效', 400);
  if (name !== current.name) {
    const duplicateName = await env.DB.prepare(
      'SELECT 1 AS found FROM database_templates WHERE database_id = ? AND name = ? AND id <> ?',
    )
      .bind(authorization.database.id, name, templateId)
      .first<{ found: number }>();
    if (duplicateName) return error('已有同名模板', 409);
  }
  const description =
    input.description === undefined
      ? current.description
      : typeof input.description === 'string'
        ? input.description.trim().slice(0, 500)
        : null;
  if (description === null) return error('模板说明无效', 400);
  const isDefault = input.isDefault === undefined ? Boolean(current.is_default) : input.isDefault;
  if (typeof isDefault !== 'boolean') return error('默认模板状态无效', 400);
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (isDefault) {
    statements.push(
      env.DB.prepare(
        'UPDATE database_templates SET is_default = 0, updated_by = ?, updated_at = ? WHERE database_id = ?',
      ).bind(actor.id, now, authorization.database.id),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE database_templates
          SET name = ?, description = ?, is_default = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND database_id = ?`,
    ).bind(
      name,
      description,
      isDefault ? 1 : 0,
      actor.id,
      now,
      templateId,
      authorization.database.id,
    ),
    env.DB.prepare('UPDATE pages SET title = ?, updated_by = ?, updated_at = ? WHERE id = ?').bind(
      `模板 · ${name}`,
      actor.id,
      now,
      current.page_id,
    ),
    env.DB.prepare(
      'UPDATE page_search_projection SET title = ?, updated_at = ? WHERE page_id = ?',
    ).bind(`模板 · ${name}`, now, current.page_id),
    env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(current.page_id),
    env.DB.prepare(
      `INSERT INTO page_search_fts(page_id, title, normalized_body)
       SELECT page_id, ?, normalized_body FROM page_search_projection WHERE page_id = ?`,
    ).bind(searchIndexText(`模板 · ${name}`), current.page_id),
  );
  await env.DB.batch(statements);
  const template = await env.DB.prepare(
    `SELECT id, database_id, page_id, name, description, values_json, is_default,
            created_by, updated_by, created_at, updated_at
       FROM database_templates WHERE id = ?`,
  )
    .bind(templateId)
    .first<TemplateRecord>();
  if (!template) return error('模板不存在', 404);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.template.updated',
    'database_template',
    templateId,
  );
  return json({ template: templateSummary(template) });
}

async function deleteDatabaseTemplate(
  env: Env,
  authorization: DatabaseAuthorization,
  templateId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  if (authorization.database.is_locked) return error('数据库已锁定，不能删除模板', 409);
  const template = await env.DB.prepare(
    'SELECT page_id FROM database_templates WHERE id = ? AND database_id = ?',
  )
    .bind(templateId, authorization.database.id)
    .first<{ page_id: string }>();
  if (!template) return error('模板不存在', 404);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM database_templates WHERE id = ? AND database_id = ?').bind(
      templateId,
      authorization.database.id,
    ),
    env.DB.prepare(
      'UPDATE pages SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    ).bind(now, actor.id, now, template.page_id),
  ]);
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.template.deleted',
    'database_template',
    templateId,
  );
  return json({ ok: true });
}

async function createRowFromTemplate(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  templateId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const template = await env.DB.prepare(
    `SELECT t.id, t.database_id, t.page_id, t.name, t.description, t.values_json, t.is_default,
            t.created_by, t.updated_by, t.created_at, t.updated_at, p.current_generation
       FROM database_templates t JOIN pages p ON p.id = t.page_id
      WHERE t.id = ? AND t.database_id = ? AND p.deleted_at IS NULL`,
  )
    .bind(templateId, authorization.database.id)
    .first<TemplateRecord & { current_generation: number }>();
  if (!template) return error('模板不存在', 404);
  const input = (await requestBody(request)) ?? {};
  const overrides = jsonObject(input.values ?? {});
  if (!overrides) return error('模板覆盖值无效', 400);
  const properties = await databaseProperties(env, authorization.database.id);
  const typeById = new Map(properties.map((property) => [property.id, property.type]));
  const templateValues = parsedObject(template.values_json);
  const mergedValues = { ...templateValues, ...overrides };
  const createValues = Object.fromEntries(
    Object.entries(mergedValues).filter(([propertyId]) => typeById.get(propertyId) !== 'files'),
  );
  const createdResponse = await createRow(
    new Request('https://rdocs.internal/api/database-template-row', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: createValues }),
    }),
    env,
    authorization,
    actor,
  );
  if (!createdResponse.ok) return createdResponse;
  const payload = (await createdResponse.clone().json()) as { row?: DatabaseRowSummary };
  if (!payload.row) return error('模板记录创建失败', 500);
  try {
    const attachmentIds = await copyPageContent(env, {
      organizationId: authorization.database.organization_id,
      sourcePageId: template.page_id,
      sourceGeneration: Number(template.current_generation),
      targetPageId: payload.row.pageId,
      actorId: actor.id,
    });
    const fileValues = Object.fromEntries(
      Object.entries(mergedValues).flatMap(([propertyId, value]) => {
        if (typeById.get(propertyId) !== 'files' || !Array.isArray(value)) return [];
        return [
          [
            propertyId,
            value.flatMap((attachmentId) =>
              typeof attachmentId === 'string' && attachmentIds.has(attachmentId)
                ? [attachmentIds.get(attachmentId)!]
                : [],
            ),
          ],
        ];
      }),
    );
    const finalResponse = Object.keys(fileValues).length
      ? await updateRow(
          new Request('https://rdocs.internal/api/database-template-row-files', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ values: fileValues }),
          }),
          env,
          authorization,
          payload.row.id,
          actor,
        )
      : createdResponse;
    if (!finalResponse.ok) throw new PageContentCopyError('模板文件属性初始化失败');
    await databaseAudit(
      env,
      authorization.database,
      actor.id,
      'database.row.created_from_template',
      'database_row',
      payload.row.id,
      { templateId },
    );
    return finalResponse;
  } catch (reason) {
    await cleanupCreatedRow(env, authorization, payload.row, properties, actor.id);
    return reason instanceof PageContentCopyError
      ? error(reason.message, reason.status)
      : error('无法从模板创建记录', 500);
  }
}

async function listDatabaseFormLinks(
  env: Env,
  authorization: DatabaseAuthorization,
): Promise<Response> {
  const links = (
    await env.DB.prepare(
      `SELECT id, organization_id, database_id, view_id, token_hash, status,
              expires_at, created_by, created_at, revoked_at
         FROM database_form_links WHERE database_id = ? ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(authorization.database.id)
      .all<FormLinkRecord>()
  ).results;
  return json({ links: links.map(formLinkSummary) });
}

async function createDatabaseFormLink(
  request: Request,
  env: Env,
  authorization: DatabaseAuthorization,
  actor: AuthUserSummary,
): Promise<Response> {
  const input = await requestBody(request);
  const viewId = typeof input?.viewId === 'string' ? input.viewId : '';
  if (!isPageId(viewId)) return error('表单视图 ID 无效', 400);
  const view = await env.DB.prepare(
    `SELECT id, database_id, name, type, config_json, sort_order, created_at, updated_at
       FROM database_views WHERE id = ? AND database_id = ? AND type = 'form'`,
  )
    .bind(viewId, authorization.database.id)
    .first<ViewRecord>();
  if (!view) return error('表单视图不存在', 404);
  let expiresAt: number | null = null;
  if (input?.expiresInDays !== undefined && input.expiresInDays !== null) {
    if (
      typeof input.expiresInDays !== 'number' ||
      !Number.isInteger(input.expiresInDays) ||
      input.expiresInDays < 1 ||
      input.expiresInDays > 365
    ) {
      return error('表单有效期必须是 1–365 天', 400);
    }
    expiresAt = Date.now() + input.expiresInDays * 86_400_000;
  }
  const id = crypto.randomUUID();
  const token = randomFormToken();
  const tokenHash = await sha256Text(token);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO database_form_links(
       id, organization_id, database_id, view_id, token_hash, status,
       expires_at, created_by, created_at, revoked_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, NULL)`,
  )
    .bind(
      id,
      authorization.database.organization_id,
      authorization.database.id,
      viewId,
      tokenHash,
      expiresAt,
      actor.id,
      now,
    )
    .run();
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.form_link.created',
    'database_view',
    viewId,
    { formLinkId: id, expiresAt },
  );
  const link: FormLinkRecord = {
    id,
    organization_id: authorization.database.organization_id,
    database_id: authorization.database.id,
    view_id: viewId,
    token_hash: tokenHash,
    status: 'active',
    expires_at: expiresAt,
    created_by: actor.id,
    created_at: now,
    revoked_at: null,
  };
  return json({ link: formLinkSummary(link), token, path: `/forms/${token}` }, { status: 201 });
}

async function revokeDatabaseFormLink(
  env: Env,
  linkId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const link = await env.DB.prepare(
    `SELECT id, organization_id, database_id, view_id, token_hash, status,
            expires_at, created_by, created_at, revoked_at
       FROM database_form_links WHERE id = ?`,
  )
    .bind(linkId)
    .first<FormLinkRecord>();
  if (!link) return error('表单链接不存在', 404);
  const authorization = await authorizeDatabase(env, link.database_id, actor.id, 'edit_content');
  if (!authorization) return error('表单链接不存在或无权撤销', 404);
  const now = Date.now();
  await env.DB.prepare(
    `UPDATE database_form_links SET status = 'revoked', revoked_at = ?
      WHERE id = ? AND status = 'active'`,
  )
    .bind(now, linkId)
    .run();
  await databaseAudit(
    env,
    authorization.database,
    actor.id,
    'database.form_link.revoked',
    'database_view',
    link.view_id,
    { formLinkId: linkId },
  );
  return json({ ok: true, revokedAt: now });
}

async function findPublicForm(env: Env, token: string): Promise<FormLinkRecord | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const tokenHash = await sha256Text(token);
  return env.DB.prepare(
    `SELECT f.id, f.organization_id, f.database_id, f.view_id, f.token_hash,
            f.status, f.expires_at, f.created_by, f.created_at, f.revoked_at,
            p.title AS database_title, p.id AS page_id, v.name AS view_name,
            v.config_json AS view_config_json, d.is_locked,
            d.created_by AS database_created_by, d.updated_by AS database_updated_by,
            d.created_at AS database_created_at, d.updated_at AS database_updated_at
       FROM database_form_links f
       JOIN databases d ON d.id = f.database_id
       JOIN pages p ON p.id = d.page_id AND p.deleted_at IS NULL
       JOIN database_views v ON v.id = f.view_id AND v.database_id = f.database_id AND v.type = 'form'
      WHERE f.token_hash = ? AND f.status = 'active'
        AND (f.expires_at IS NULL OR f.expires_at > ?)`,
  )
    .bind(tokenHash, Date.now())
    .first<FormLinkRecord>();
}

async function publicFormDefinition(
  env: Env,
  form: FormLinkRecord,
): Promise<PublicDatabaseFormDefinition> {
  const config = parsedObject(form.view_config_json ?? '{}');
  const properties = (await databaseProperties(env, form.database_id)).map(propertySummary);
  const visibleIds = Array.isArray(config.visiblePropertyIds)
    ? new Set(config.visiblePropertyIds.filter((id): id is string => typeof id === 'string'))
    : null;
  const requiredIds = new Set(
    Array.isArray(config.requiredPropertyIds)
      ? config.requiredPropertyIds.filter((id): id is string => typeof id === 'string')
      : [],
  );
  const order = Array.isArray(config.propertyOrder)
    ? config.propertyOrder.filter((id): id is string => typeof id === 'string')
    : [];
  const orderIndex = new Map(order.map((id, index) => [id, index]));
  const fields = properties
    .filter(
      (property) =>
        PUBLIC_FORM_PROPERTY_TYPES.has(property.type) &&
        (!visibleIds || property.type === 'title' || visibleIds.has(property.id)),
    )
    .sort(
      (left, right) =>
        (orderIndex.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderIndex.get(right.id) ?? Number.MAX_SAFE_INTEGER) || left.sortOrder - right.sortOrder,
    )
    .map((property) => ({
      id: property.id,
      name: property.name,
      type: property.type,
      config: property.config,
      required: requiredIds.has(property.id),
    }));
  return {
    id: form.id,
    title:
      typeof config.formTitle === 'string'
        ? config.formTitle
        : (form.view_name ?? form.database_title ?? 'Rdocs 表单'),
    description: typeof config.formDescription === 'string' ? config.formDescription : '',
    submitLabel: typeof config.submitLabel === 'string' ? config.submitLabel : '提交',
    successMessage:
      typeof config.successMessage === 'string' ? config.successMessage : '提交成功，感谢填写。',
    fields,
    expiresAt: form.expires_at === null ? null : Number(form.expires_at),
  };
}

function publicFormValueMissing(value: unknown): boolean {
  return (
    value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)
  );
}

export async function handlePublicDatabaseFormsApi(
  request: Request,
  env: Env,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/public\/forms\/([^/]+)$/);
  if (!match?.[1] || !['GET', 'POST'].includes(request.method)) return null;
  const form = await findPublicForm(env, decodeURIComponent(match[1]));
  if (!form) return error('表单不存在、已过期或已关闭', 404);
  const definition = await publicFormDefinition(env, form);
  if (request.method === 'GET') return json({ form: definition });
  if (form.is_locked) return error('此表单当前已暂停收集', 409);
  const recent = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM database_form_submissions
      WHERE form_link_id = ? AND created_at >= ?`,
  )
    .bind(form.id, Date.now() - 60_000)
    .first<{ count: number }>();
  if (Number(recent?.count ?? 0) >= PUBLIC_FORM_RATE_LIMIT_PER_MINUTE) {
    return error('提交过于频繁，请稍后再试', 429);
  }
  const input = await requestBody(request);
  const submittedValues =
    input?.values && typeof input.values === 'object' && !Array.isArray(input.values)
      ? (input.values as Record<string, unknown>)
      : null;
  if (!submittedValues) return error('表单内容无效', 400);
  const allowed = new Set(definition.fields.map((field) => field.id));
  if (Object.keys(submittedValues).some((propertyId) => !allowed.has(propertyId))) {
    return error('表单包含未公开的字段', 400);
  }
  for (const field of definition.fields) {
    if (field.required && publicFormValueMissing(submittedValues[field.id])) {
      return error(`“${field.name}”为必填项`, 400);
    }
  }
  const database: DatabaseRecord = {
    id: form.database_id,
    organization_id: form.organization_id,
    page_id: form.page_id ?? '',
    title: form.database_title ?? '',
    is_locked: Number(form.is_locked ?? 0),
    created_by: form.database_created_by ?? PUBLIC_FORM_ACTOR_ID,
    updated_by: form.database_updated_by ?? PUBLIC_FORM_ACTOR_ID,
    created_at: Number(form.database_created_at ?? 0),
    updated_at: Number(form.database_updated_at ?? 0),
  };
  const actor: AuthUserSummary = {
    id: PUBLIC_FORM_ACTOR_ID,
    email: 'forms@system.rdocs.invalid',
    displayName: 'Rdocs Forms',
    avatarUrl: null,
  };
  const created = await createRow(
    new Request('https://rdocs.internal/api/public-form-submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ values: submittedValues }),
    }),
    env,
    { database, role: 'editor' },
    actor,
    { triggerType: 'form_submitted' },
  );
  if (!created.ok) return created;
  const payload = (await created.clone().json()) as { row?: DatabaseRowSummary };
  if (!payload.row) return error('表单记录创建失败', 500);
  await env.DB.prepare(
    `INSERT INTO database_form_submissions(id, organization_id, form_link_id, row_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(crypto.randomUUID(), form.organization_id, form.id, payload.row.id, Date.now())
    .run();
  return json(
    { ok: true, submissionId: payload.row.id, message: definition.successMessage },
    { status: 201 },
  );
}

async function createProjectWorkspace(
  request: Request,
  env: Env,
  spaceId: string,
  actor: AuthUserSummary,
): Promise<Response> {
  const access = await requireSpaceAction(env, spaceId, actor.id, 'create_child');
  if (!access) return error('空间不存在或无权创建项目工作区', 404);
  const input = (await requestBody(request)) ?? {};
  const name = entityName(input.name ?? '项目中心', 100);
  if (!name) return error('项目工作区名称无效', 400);
  const now = Date.now();
  const hubPageId = crypto.randomUUID();
  const projectsPageId = crypto.randomUUID();
  const tasksPageId = crypto.randomUUID();
  const sprintsPageId = crypto.randomUUID();
  const projectsDatabaseId = crypto.randomUUID();
  const tasksDatabaseId = crypto.randomUUID();
  const sprintsDatabaseId = crypto.randomUUID();

  const projectTitleId = crypto.randomUUID();
  const projectStatusId = crypto.randomUUID();
  const projectOwnerId = crypto.randomUUID();
  const projectDateId = crypto.randomUUID();
  const projectPriorityId = crypto.randomUUID();
  const projectTasksId = crypto.randomUUID();
  const projectProgressId = crypto.randomUUID();
  const taskTitleId = crypto.randomUUID();
  const taskStatusId = crypto.randomUUID();
  const taskAssigneeId = crypto.randomUUID();
  const taskDateId = crypto.randomUUID();
  const taskPriorityId = crypto.randomUUID();
  const taskEstimateId = crypto.randomUUID();
  const taskDoneId = crypto.randomUUID();
  const taskProjectId = crypto.randomUUID();
  const taskSprintId = crypto.randomUUID();
  const taskDependencyId = crypto.randomUUID();
  const taskParentId = crypto.randomUUID();
  const sprintTitleId = crypto.randomUUID();
  const sprintStatusId = crypto.randomUUID();
  const sprintOwnerId = crypto.randomUUID();
  const sprintDateId = crypto.randomUUID();
  const sprintGoalId = crypto.randomUUID();
  const sprintTasksId = crypto.randomUUID();

  const statements: D1PreparedStatement[] = [];
  const addPage = (id: string, parentId: string | null, title: string, sortOrder: number) => {
    const sortKey = `${now.toString().padStart(20, '0')}:${sortOrder}:${id}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO pages(
           id, organization_id, space_id, parent_id, title, sort_key,
           current_generation, editor_schema_version, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        access.organizationId,
        spaceId,
        parentId,
        title,
        sortKey,
        EDITOR_SCHEMA_VERSION,
        actor.id,
        actor.id,
        now,
        now,
      ),
      env.DB.prepare(
        `INSERT INTO page_access_state(page_id, collaboration_enabled, acl_version, updated_at)
         VALUES (?, 1, 1, ?)`,
      ).bind(id, now),
      env.DB.prepare(
        `INSERT INTO page_search_projection(
           page_id, organization_id, space_id, generation, collab_seq,
           title, normalized_body, updated_at
         ) VALUES (?, ?, ?, 1, 0, ?, '', ?)`,
      ).bind(id, access.organizationId, spaceId, title, now),
      env.DB.prepare(
        'INSERT INTO page_search_fts(page_id, title, normalized_body) VALUES (?, ?, ?)',
      ).bind(id, searchIndexText(title), searchIndexText(title)),
    );
  };
  addPage(hubPageId, null, name, 0);
  addPage(projectsPageId, hubPageId, '项目', 1);
  addPage(tasksPageId, hubPageId, '任务', 2);
  addPage(sprintsPageId, hubPageId, 'Sprint', 3);

  const addDatabase = (id: string, pageId: string) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO databases(
           id, organization_id, page_id, is_locked, created_by, updated_by, created_at, updated_at
         ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
      ).bind(id, access.organizationId, pageId, actor.id, actor.id, now, now),
      env.DB.prepare(
        `INSERT INTO database_counters(database_id, next_row_sequence) VALUES (?, 1)
         ON CONFLICT(database_id) DO NOTHING`,
      ).bind(id),
    );
  };
  addDatabase(projectsDatabaseId, projectsPageId);
  addDatabase(tasksDatabaseId, tasksPageId);
  addDatabase(sprintsDatabaseId, sprintsPageId);

  const addProperty = (
    id: string,
    databaseId: string,
    name: string,
    type: DatabasePropertyType,
    sortOrder: number,
    config: Record<string, JsonValue> = {},
  ) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO database_properties(
           id, organization_id, database_id, name, type, config_json, sort_order,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        access.organizationId,
        databaseId,
        name,
        type,
        JSON.stringify(config),
        sortOrder,
        actor.id,
        now,
        now,
      ),
    );
  };
  const statusOptions = { options: ['未开始', '进行中', '受阻', '已完成'] };
  const sprintStatusOptions = { options: ['规划中', '进行中', '已完成'] };
  const priorityOptions = { options: ['紧急', '高', '中', '低'] };
  addProperty(projectTitleId, projectsDatabaseId, '项目名称', 'title', 0);
  addProperty(projectStatusId, projectsDatabaseId, '状态', 'status', 1, statusOptions);
  addProperty(projectOwnerId, projectsDatabaseId, '负责人', 'person', 2);
  addProperty(projectDateId, projectsDatabaseId, '周期', 'date', 3);
  addProperty(projectPriorityId, projectsDatabaseId, '优先级', 'select', 4, priorityOptions);
  addProperty(projectTasksId, projectsDatabaseId, '任务', 'relation', 5, {
    targetDatabaseId: tasksDatabaseId,
    syncedPropertyId: taskProjectId,
  });
  addProperty(projectProgressId, projectsDatabaseId, '完成度', 'rollup', 6, {
    relationPropertyId: projectTasksId,
    targetDatabaseId: tasksDatabaseId,
    targetPropertyId: taskDoneId,
    calculation: 'percent_checked',
  });

  addProperty(taskTitleId, tasksDatabaseId, '任务名称', 'title', 0);
  addProperty(taskStatusId, tasksDatabaseId, '状态', 'status', 1, statusOptions);
  addProperty(taskAssigneeId, tasksDatabaseId, '负责人', 'person', 2);
  addProperty(taskDateId, tasksDatabaseId, '日期', 'date', 3);
  addProperty(taskPriorityId, tasksDatabaseId, '优先级', 'select', 4, priorityOptions);
  addProperty(taskEstimateId, tasksDatabaseId, '估算', 'number', 5, { format: 'number' });
  addProperty(taskDoneId, tasksDatabaseId, '完成', 'checkbox', 6);
  addProperty(taskProjectId, tasksDatabaseId, '所属项目', 'relation', 7, {
    targetDatabaseId: projectsDatabaseId,
    syncedPropertyId: projectTasksId,
  });
  addProperty(taskSprintId, tasksDatabaseId, 'Sprint', 'relation', 8, {
    targetDatabaseId: sprintsDatabaseId,
    syncedPropertyId: sprintTasksId,
  });
  addProperty(taskDependencyId, tasksDatabaseId, '依赖任务', 'relation', 9, {
    targetDatabaseId: tasksDatabaseId,
  });
  addProperty(taskParentId, tasksDatabaseId, '父任务', 'relation', 10, {
    targetDatabaseId: tasksDatabaseId,
  });

  addProperty(sprintTitleId, sprintsDatabaseId, 'Sprint 名称', 'title', 0);
  addProperty(sprintStatusId, sprintsDatabaseId, '状态', 'status', 1, sprintStatusOptions);
  addProperty(sprintOwnerId, sprintsDatabaseId, '负责人', 'person', 2);
  addProperty(sprintDateId, sprintsDatabaseId, '周期', 'date', 3);
  addProperty(sprintGoalId, sprintsDatabaseId, '目标', 'text', 4);
  addProperty(sprintTasksId, sprintsDatabaseId, '任务', 'relation', 5, {
    targetDatabaseId: tasksDatabaseId,
    syncedPropertyId: taskSprintId,
  });

  const addView = (
    databaseId: string,
    name: string,
    type: DatabaseViewType,
    sortOrder: number,
    config: Record<string, JsonValue> = {},
  ) => {
    statements.push(
      env.DB.prepare(
        `INSERT INTO database_views(
           id, organization_id, database_id, name, type, config_json, sort_order,
           created_by, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        access.organizationId,
        databaseId,
        name,
        type,
        JSON.stringify(config),
        sortOrder,
        actor.id,
        now,
        now,
      ),
    );
  };
  addView(projectsDatabaseId, '所有项目', 'table', 0);
  addView(projectsDatabaseId, '按状态', 'board', 1, { groupPropertyId: projectStatusId });
  addView(projectsDatabaseId, '项目时间线', 'timeline', 2, { datePropertyId: projectDateId });
  addView(tasksDatabaseId, '所有任务', 'table', 0);
  addView(tasksDatabaseId, '任务看板', 'board', 1, { groupPropertyId: taskStatusId });
  addView(tasksDatabaseId, '任务日历', 'calendar', 2, { datePropertyId: taskDateId });
  addView(tasksDatabaseId, '任务时间线', 'timeline', 3, { datePropertyId: taskDateId });
  addView(sprintsDatabaseId, '所有 Sprint', 'table', 0);
  addView(sprintsDatabaseId, 'Sprint 看板', 'board', 1, { groupPropertyId: sprintStatusId });
  addView(sprintsDatabaseId, 'Sprint 时间线', 'timeline', 2, { datePropertyId: sprintDateId });

  const summary: ProjectWorkspaceSummary = {
    hubPageId,
    projectsPageId,
    tasksPageId,
    sprintsPageId,
    projectsDatabaseId,
    tasksDatabaseId,
    sprintsDatabaseId,
  };
  statements.push(
    env.DB.prepare(
      `INSERT INTO audit_events(
         id, organization_id, actor_id, event_type, target_type,
         target_id, metadata_json, created_at
       ) VALUES (?, ?, ?, 'project.workspace.created', 'page', ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      access.organizationId,
      actor.id,
      hubPageId,
      JSON.stringify(summary),
      now,
    ),
  );
  await env.DB.batch(statements);
  return json({ workspace: summary }, { status: 201 });
}

export async function handleDatabasesApi(
  request: Request,
  env: Env,
  actor: AuthUserSummary,
): Promise<Response | null> {
  const url = new URL(request.url);

  const projectWorkspaceMatch = url.pathname.match(/^\/api\/spaces\/([^/]+)\/project-workspaces$/);
  if (projectWorkspaceMatch?.[1] && request.method === 'POST') {
    return createProjectWorkspace(
      request,
      env,
      decodeURIComponent(projectWorkspaceMatch[1]),
      actor,
    );
  }

  const automationRunMatch = url.pathname.match(
    /^\/api\/databases\/([^/]+)\/automations\/([^/]+)\/run$/,
  );
  if (automationRunMatch?.[1] && automationRunMatch[2] && request.method === 'POST') {
    const databaseId = decodeURIComponent(automationRunMatch[1]);
    const automationId = decodeURIComponent(automationRunMatch[2]);
    if (!isPageId(databaseId) || !isPageId(automationId)) {
      return error('数据库或自动化 ID 无效', 400);
    }
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? runManualDatabaseAutomation(request, env, authorization, automationId, actor)
      : error('数据库不存在或无权运行自动化', 404);
  }

  const automationMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/automations\/([^/]+)$/);
  if (automationMatch?.[1] && automationMatch[2]) {
    const databaseId = decodeURIComponent(automationMatch[1]);
    const automationId = decodeURIComponent(automationMatch[2]);
    if (!isPageId(databaseId) || !isPageId(automationId)) {
      return error('数据库或自动化 ID 无效', 400);
    }
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权管理自动化', 404);
    if (request.method === 'PATCH') {
      return updateDatabaseAutomation(request, env, authorization, automationId, actor);
    }
    if (request.method === 'DELETE') {
      return deleteDatabaseAutomation(env, authorization, automationId, actor);
    }
  }

  const automationsMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/automations$/);
  if (automationsMatch?.[1]) {
    const databaseId = decodeURIComponent(automationsMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权管理自动化', 404);
    if (request.method === 'GET') return listDatabaseAutomations(env, authorization);
    if (request.method === 'POST') {
      return createDatabaseAutomation(request, env, authorization, actor);
    }
  }

  const templateRowMatch = url.pathname.match(
    /^\/api\/databases\/([^/]+)\/templates\/([^/]+)\/rows$/,
  );
  if (templateRowMatch?.[1] && templateRowMatch[2] && request.method === 'POST') {
    const databaseId = decodeURIComponent(templateRowMatch[1]);
    const templateId = decodeURIComponent(templateRowMatch[2]);
    if (!isPageId(databaseId) || !isPageId(templateId)) {
      return error('数据库或模板 ID 无效', 400);
    }
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? createRowFromTemplate(request, env, authorization, templateId, actor)
      : error('数据库不存在或无权编辑', 404);
  }

  const templateMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/templates\/([^/]+)$/);
  if (templateMatch?.[1] && templateMatch[2]) {
    const databaseId = decodeURIComponent(templateMatch[1]);
    const templateId = decodeURIComponent(templateMatch[2]);
    if (!isPageId(databaseId) || !isPageId(templateId)) {
      return error('数据库或模板 ID 无效', 400);
    }
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权管理模板', 404);
    if (request.method === 'PATCH') {
      return updateDatabaseTemplate(request, env, authorization, templateId, actor);
    }
    if (request.method === 'DELETE') {
      return deleteDatabaseTemplate(env, authorization, templateId, actor);
    }
  }

  const templatesMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/templates$/);
  if (templatesMatch?.[1] && request.method === 'POST') {
    const databaseId = decodeURIComponent(templatesMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? createDatabaseTemplate(request, env, authorization, actor)
      : error('数据库不存在或无权管理模板', 404);
  }

  const buttonMatch = url.pathname.match(
    /^\/api\/databases\/([^/]+)\/rows\/([^/]+)\/buttons\/([^/]+)$/,
  );
  if (buttonMatch?.[1] && buttonMatch[2] && buttonMatch[3] && request.method === 'POST') {
    const databaseId = decodeURIComponent(buttonMatch[1]);
    const rowId = decodeURIComponent(buttonMatch[2]);
    const propertyId = decodeURIComponent(buttonMatch[3]);
    if (!isPageId(databaseId) || !isPageId(rowId) || !isPageId(propertyId)) {
      return error('数据库、记录或按钮 ID 无效', 400);
    }
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? executeDatabaseButton(env, authorization, rowId, propertyId, actor)
      : error('数据库不存在或无权执行按钮', 404);
  }

  const formLinkMatch = url.pathname.match(/^\/api\/database-form-links\/([^/]+)$/);
  if (formLinkMatch?.[1] && request.method === 'DELETE') {
    const linkId = decodeURIComponent(formLinkMatch[1]);
    if (!isPageId(linkId)) return error('表单链接 ID 无效', 400);
    return revokeDatabaseFormLink(env, linkId, actor);
  }

  const databaseFormsMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/forms$/);
  if (databaseFormsMatch?.[1]) {
    const databaseId = decodeURIComponent(databaseFormsMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权管理表单', 404);
    if (request.method === 'GET') return listDatabaseFormLinks(env, authorization);
    if (request.method === 'POST') {
      return createDatabaseFormLink(request, env, authorization, actor);
    }
  }

  const organizationDatabasesMatch = url.pathname.match(
    /^\/api\/organizations\/([^/]+)\/databases$/,
  );
  if (organizationDatabasesMatch?.[1] && request.method === 'GET') {
    return listOrganizationDatabases(
      env,
      decodeURIComponent(organizationDatabasesMatch[1]),
      actor.id,
    );
  }

  const pageDatabaseMatch = url.pathname.match(/^\/api\/pages\/([^/]+)\/database$/);
  if (pageDatabaseMatch?.[1]) {
    const pageId = decodeURIComponent(pageDatabaseMatch[1]);
    if (!isPageId(pageId)) return error('页面 ID 无效', 400);
    if (request.method === 'POST') return createDatabase(request, env, pageId, actor);
    if (request.method === 'GET') {
      const pageAccess = await requirePageAction(env, pageId, actor.id, 'view');
      if (!pageAccess) return error('页面不存在或无权访问', 404);
      const authorization = await authorizeDatabasePage(env, pageId, actor.id, 'view');
      return authorization
        ? json(await snapshot(env, authorization, actor.id))
        : json({ database: null });
    }
  }

  const propertyMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/properties\/([^/]+)$/);
  if (propertyMatch?.[1] && propertyMatch[2]) {
    const databaseId = decodeURIComponent(propertyMatch[1]);
    const propertyId = decodeURIComponent(propertyMatch[2]);
    if (!isPageId(databaseId) || !isPageId(propertyId)) return error('数据库或属性 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权修改', 404);
    if (request.method === 'PATCH')
      return updateProperty(request, env, authorization, propertyId, actor);
    if (request.method === 'DELETE') return deleteProperty(env, authorization, propertyId, actor);
  }

  const propertiesMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/properties$/);
  if (propertiesMatch?.[1] && request.method === 'POST') {
    const databaseId = decodeURIComponent(propertiesMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? createProperty(request, env, authorization, actor)
      : error('数据库不存在或无权修改', 404);
  }

  const viewMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/views\/([^/]+)$/);
  if (viewMatch?.[1] && viewMatch[2]) {
    const databaseId = decodeURIComponent(viewMatch[1]);
    const viewId = decodeURIComponent(viewMatch[2]);
    if (!isPageId(databaseId) || !isPageId(viewId)) return error('数据库或视图 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权修改', 404);
    if (request.method === 'PATCH') return updateView(request, env, authorization, viewId, actor);
    if (request.method === 'DELETE') return deleteView(env, authorization, viewId, actor);
  }

  const viewsMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/views$/);
  if (viewsMatch?.[1] && request.method === 'POST') {
    const databaseId = decodeURIComponent(viewsMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? createView(request, env, authorization, actor)
      : error('数据库不存在或无权修改', 404);
  }

  const rowMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/rows\/([^/]+)$/);
  if (rowMatch?.[1] && rowMatch[2]) {
    const databaseId = decodeURIComponent(rowMatch[1]);
    const rowId = decodeURIComponent(rowMatch[2]);
    if (!isPageId(databaseId) || !isPageId(rowId)) return error('数据库或数据行 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权编辑', 404);
    if (request.method === 'PATCH') return updateRow(request, env, authorization, rowId, actor);
    if (request.method === 'DELETE') {
      return updateRow(
        new Request(request.url, {
          method: 'PATCH',
          headers: request.headers,
          body: JSON.stringify({ values: {}, archived: true }),
        }),
        env,
        authorization,
        rowId,
        actor,
      );
    }
  }

  const duplicateRowMatch = url.pathname.match(
    /^\/api\/databases\/([^/]+)\/rows\/([^/]+)\/duplicate$/,
  );
  if (duplicateRowMatch?.[1] && duplicateRowMatch[2] && request.method === 'POST') {
    const databaseId = decodeURIComponent(duplicateRowMatch[1]);
    const rowId = decodeURIComponent(duplicateRowMatch[2]);
    if (!isPageId(databaseId) || !isPageId(rowId)) return error('数据库或数据行 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? duplicateRow(env, authorization, rowId, actor)
      : error('数据库不存在或无权编辑', 404);
  }

  const csvImportMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/import\/csv$/);
  if (csvImportMatch?.[1] && request.method === 'POST') {
    const databaseId = decodeURIComponent(csvImportMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    if (!authorization) return error('数据库不存在或无权导入', 404);
    const text = await request.text();
    if (!text.trim() || text.length > 1_000_000) return error('CSV 为空或超过 1 MB', 400);
    const lines = text
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const header = lines.shift();
    if (!header) return error('CSV 没有表头', 400);
    const names = splitCsvLine(header);
    const properties = (await snapshot(env, authorization, actor.id)).properties;
    const columns = names.map((name) =>
      properties.find((property) => property.name === name || property.id === name),
    );
    if (!columns.some(Boolean)) return error('CSV 表头没有匹配的属性', 400);
    let imported = 0;
    for (const line of lines.slice(0, 200)) {
      const cells = splitCsvLine(line);
      const values: Record<string, JsonValue> = {};
      for (const [index, property] of columns.entries()) {
        if (!property) continue;
        const raw = cells[index] ?? '';
        values[property.id] =
          property.type === 'number'
            ? Number(raw) || 0
            : property.type === 'checkbox'
              ? ['true', '1', 'yes', '是'].includes(raw.toLowerCase())
              : property.type === 'multi_select'
                ? raw
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean)
                : raw;
      }
      const created = await createRow(
        new Request('https://rdocs.internal/api/database-import', {
          headers: { 'content-type': 'application/json' },
          method: 'POST',
          body: JSON.stringify({ values }),
        }),
        env,
        authorization,
        actor,
      );
      if (created.ok) imported += 1;
    }
    return json({ imported }, { status: imported ? 201 : 400 });
  }

  const rowsMatch = url.pathname.match(/^\/api\/databases\/([^/]+)\/rows$/);
  if (rowsMatch?.[1] && request.method === 'POST') {
    const databaseId = decodeURIComponent(rowsMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
    return authorization
      ? createRow(request, env, authorization, actor)
      : error('数据库不存在或无权编辑', 404);
  }

  const databaseMatch = url.pathname.match(/^\/api\/databases\/([^/]+)$/);
  if (databaseMatch?.[1]) {
    const databaseId = decodeURIComponent(databaseMatch[1]);
    if (!isPageId(databaseId)) return error('数据库 ID 无效', 400);
    if (request.method === 'GET') {
      const rowState = url.searchParams.get('archived') === 'true' ? 'archived' : 'active';
      const authorization = await authorizeDatabase(
        env,
        databaseId,
        actor.id,
        rowState === 'archived' ? 'edit_content' : 'view',
      );
      return authorization
        ? json(await snapshot(env, authorization, actor.id, rowState))
        : error('数据库不存在或无权访问', 404);
    }
    if (request.method === 'PATCH') {
      const authorization = await authorizeDatabase(env, databaseId, actor.id, 'edit_content');
      return authorization
        ? updateDatabase(request, env, authorization, actor)
        : error('数据库不存在或无权修改', 404);
    }
  }

  return null;
}

import type { JsonValue } from './index';

/**
 * Database automations, shaped like Notion's: when <trigger>, if <conditions>,
 * do <actions> in order. Stored as JSON in database_automations; older
 * single-action records are read through `automationDefinitionFromRecord`.
 */

export const AUTOMATION_TRIGGER_TYPES = [
  'row_created',
  'row_updated',
  'property_changed',
  'form_submitted',
  'manual',
  'schedule',
] as const;
export type AutomationTriggerType = (typeof AUTOMATION_TRIGGER_TYPES)[number];

export const AUTOMATION_ACTION_TYPES = [
  'set_property',
  'toggle_checkbox',
  'increment_number',
  'archive_row',
  'create_row',
  'edit_rows',
  'notify',
  'webhook',
  'notion_create_page',
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

/** Actions that change the record that triggered the run, so they need one. */
export const ROW_ACTION_TYPES: ReadonlySet<AutomationActionType> = new Set([
  'set_property',
  'toggle_checkbox',
  'increment_number',
  'archive_row',
]);

export const AUTOMATION_CONDITION_OPS = [
  'eq',
  'neq',
  'contains',
  'not_contains',
  'is_empty',
  'not_empty',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_checked',
  'not_checked',
] as const;
export type AutomationConditionOp = (typeof AUTOMATION_CONDITION_OPS)[number];

export interface AutomationConditionRule {
  propertyId: string;
  op: AutomationConditionOp;
  value?: JsonValue;
}

export interface AutomationConditions {
  match: 'all' | 'any';
  rules: AutomationConditionRule[];
}

export type AutomationFrequency = 'hourly' | 'daily' | 'weekly' | 'monthly';

export interface AutomationSchedule {
  frequency: AutomationFrequency;
  /** Local time "HH:MM"; for hourly runs only the minutes count. */
  time: string;
  /** 0 = Sunday … 6 = Saturday, for weekly runs. */
  weekdays: number[];
  /** 1–31 for monthly runs; short months run on their last day. */
  dayOfMonth: number;
}

export interface AutomationActionStep {
  type: AutomationActionType;
  config: Record<string, JsonValue>;
}

export interface AutomationDefinition {
  trigger: {
    type: AutomationTriggerType;
    /** property_changed: any of these properties. */
    propertyIds: string[];
    schedule: AutomationSchedule | null;
  };
  conditions: AutomationConditions;
  actions: AutomationActionStep[];
  /** IANA time zone for schedules and "today"; the creator's browser zone. */
  timezone: string;
}

export const MAX_AUTOMATION_ACTIONS = 10;
export const MAX_AUTOMATION_RULES = 20;

/**
 * Value placeholders inside action values and condition values:
 * `{ "$token": "now" }`, `"today"`, `"trigger_user"` (person),
 * `"trigger_row"` (relation to the record that triggered the run), or
 * `{ "$token": "copy", "propertyId": "…" }` (that record's value).
 */
export type AutomationToken = 'now' | 'today' | 'trigger_user' | 'trigger_row' | 'copy' | 'clear';

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(raw: string): Record<string, JsonValue> {
  try {
    const value = JSON.parse(raw) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

export function isValidTimeZone(timezone: string): boolean {
  if (!timezone || timezone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function normalizedTime(value: unknown): string {
  if (typeof value !== 'string') return '09:00';
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return '09:00';
  const hour = Math.min(23, Math.max(0, Number(match[1])));
  const minute = Math.min(59, Math.max(0, Number(match[2])));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeSchedule(value: unknown): AutomationSchedule | null {
  if (!isRecord(value)) return null;
  const frequency = value.frequency;
  if (
    frequency !== 'hourly' &&
    frequency !== 'daily' &&
    frequency !== 'weekly' &&
    frequency !== 'monthly'
  ) {
    return null;
  }
  const weekdays = Array.isArray(value.weekdays)
    ? [
        ...new Set(
          value.weekdays.filter(
            (day): day is number => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6,
          ),
        ),
      ].sort()
    : [];
  const dayOfMonth =
    typeof value.dayOfMonth === 'number' && Number.isInteger(value.dayOfMonth)
      ? Math.min(31, Math.max(1, value.dayOfMonth))
      : 1;
  return {
    frequency,
    time: normalizedTime(value.time),
    weekdays: frequency === 'weekly' && !weekdays.length ? [1] : weekdays,
    dayOfMonth,
  };
}

function normalizeRule(value: unknown): AutomationConditionRule | null {
  if (!isRecord(value) || typeof value.propertyId !== 'string' || !value.propertyId) return null;
  const op = (AUTOMATION_CONDITION_OPS as readonly string[]).includes(String(value.op))
    ? (value.op as AutomationConditionOp)
    : 'eq';
  return value.value === undefined
    ? { propertyId: value.propertyId, op }
    : { propertyId: value.propertyId, op, value: value.value };
}

export function normalizeConditions(value: unknown): AutomationConditions {
  if (!isRecord(value)) return { match: 'all', rules: [] };
  const rules = Array.isArray(value.rules)
    ? value.rules
        .map(normalizeRule)
        .filter((rule): rule is AutomationConditionRule => Boolean(rule))
    : [];
  return {
    match: value.match === 'any' ? 'any' : 'all',
    rules: rules.slice(0, MAX_AUTOMATION_RULES),
  };
}

function normalizeStep(value: unknown): AutomationActionStep | null {
  if (!isRecord(value)) return null;
  const type = value.type;
  if (typeof type !== 'string' || !(AUTOMATION_ACTION_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  return { type: type as AutomationActionType, config: isRecord(value.config) ? value.config : {} };
}

/** Normalize a definition sent by a client. Unknown fields are dropped. */
export function normalizeAutomationDefinition(value: unknown): AutomationDefinition | null {
  if (!isRecord(value)) return null;
  const trigger = isRecord(value.trigger) ? value.trigger : {};
  const type = trigger.type;
  if (typeof type !== 'string' || !(AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(type)) {
    return null;
  }
  const actions = Array.isArray(value.actions)
    ? value.actions.map(normalizeStep).filter((step): step is AutomationActionStep => Boolean(step))
    : [];
  const timezone =
    typeof value.timezone === 'string' && isValidTimeZone(value.timezone) ? value.timezone : 'UTC';
  return {
    trigger: {
      type: type as AutomationTriggerType,
      propertyIds: Array.isArray(trigger.propertyIds)
        ? [...new Set(trigger.propertyIds.filter((id): id is string => typeof id === 'string'))]
        : [],
      schedule: type === 'schedule' ? normalizeSchedule(trigger.schedule) : null,
    },
    conditions: normalizeConditions(value.conditions),
    actions: actions.slice(0, MAX_AUTOMATION_ACTIONS),
    timezone,
  };
}

/**
 * The definition stored in a database_automations row. Records written
 * before definitions existed kept one action in action_type/action_config,
 * extra steps under `steps`, one `condition` and an optional UTC `cron`.
 */
export function automationDefinitionFromRecord(record: {
  trigger_type: string;
  trigger_config_json: string;
  action_type: string;
  action_config_json: string;
}): AutomationDefinition {
  const triggerConfig = parseJsonObject(record.trigger_config_json);
  const actionConfig = parseJsonObject(record.action_config_json);
  if (isRecord(triggerConfig.definition)) {
    const stored = normalizeAutomationDefinition(triggerConfig.definition);
    if (stored) return stored;
  }
  const legacyCondition = normalizeRule(triggerConfig.condition);
  const legacySteps = Array.isArray(actionConfig.steps)
    ? actionConfig.steps
        .map(normalizeStep)
        .filter((step): step is AutomationActionStep => Boolean(step))
    : [];
  const { steps: _steps, ...primaryConfig } = actionConfig;
  const primary = normalizeStep({ type: record.action_type, config: primaryConfig });
  const type = (AUTOMATION_TRIGGER_TYPES as readonly string[]).includes(record.trigger_type)
    ? (record.trigger_type as AutomationTriggerType)
    : 'manual';
  const cron = typeof triggerConfig.cron === 'string' ? triggerConfig.cron.trim().split(/\s+/) : [];
  const legacySchedule =
    cron.length === 5 && /^\d+$/.test(cron[0] ?? '') && /^\d+$/.test(cron[1] ?? '')
      ? normalizeSchedule({ frequency: 'daily', time: `${cron[1]}:${cron[0]}` })
      : null;
  return {
    trigger: {
      type: legacySchedule ? 'schedule' : type,
      propertyIds: typeof triggerConfig.propertyId === 'string' ? [triggerConfig.propertyId] : [],
      schedule: legacySchedule,
    },
    conditions: { match: 'all', rules: legacyCondition ? [legacyCondition] : [] },
    actions: [...legacySteps, ...(primary ? [primary] : [])].slice(0, MAX_AUTOMATION_ACTIONS),
    timezone: 'UTC',
  };
}

// ── Conditions ───────────────────────────────────────────────────────────

export function isEmptyValue(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined || value === '' || value === false) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value) && 'start' in value) return !value.start;
  return false;
}

function comparable(value: JsonValue | undefined): number | string | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const asNumber = Number(value);
    if (value.trim() && Number.isFinite(asNumber)) return asNumber;
    const asDate = Date.parse(value);
    return Number.isNaN(asDate) ? value : asDate;
  }
  if (isRecord(value) && typeof value.start === 'string') {
    const asDate = Date.parse(value.start);
    return Number.isNaN(asDate) ? null : asDate;
  }
  return null;
}

function listOf(value: JsonValue | undefined): JsonValue[] {
  if (Array.isArray(value)) return value;
  return value === null || value === undefined ? [] : [value];
}

function sameValue(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (Array.isArray(left) && !Array.isArray(right))
    return left.some((item) => sameValue(item, right));
  const a = comparable(left);
  const b = comparable(right);
  if (a !== null && b !== null && typeof a === typeof b) return a === b;
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

export function ruleMatches(
  rule: AutomationConditionRule,
  current: JsonValue | undefined,
  expected: JsonValue | undefined,
): boolean {
  switch (rule.op) {
    case 'is_empty':
      return isEmptyValue(current);
    case 'not_empty':
      return !isEmptyValue(current);
    case 'is_checked':
      return current === true;
    case 'not_checked':
      return current !== true;
    case 'eq':
      return sameValue(current, expected);
    case 'neq':
      return !sameValue(current, expected);
    case 'contains':
    case 'not_contains': {
      const contains =
        typeof current === 'string'
          ? typeof expected === 'string' && current.toLowerCase().includes(expected.toLowerCase())
          : listOf(current).some((item) =>
              listOf(expected).some((candidate) => sameValue(item, candidate)),
            );
      return rule.op === 'contains' ? contains : !contains;
    }
    default: {
      const a = comparable(current);
      const b = comparable(expected);
      if (a === null || b === null || typeof a !== typeof b) return false;
      if (rule.op === 'gt') return a > b;
      if (rule.op === 'gte') return a >= b;
      if (rule.op === 'lt') return a < b;
      return a <= b;
    }
  }
}

/** Whether a record's values pass the conditions; an empty rule list always passes. */
export function conditionsMatch(
  conditions: AutomationConditions,
  values: Record<string, JsonValue>,
  context: AutomationValueContext,
): boolean {
  if (!conditions.rules.length) return true;
  const results = conditions.rules.map((rule) =>
    ruleMatches(rule, values[rule.propertyId], resolveAutomationValue(rule.value ?? null, context)),
  );
  return conditions.match === 'any' ? results.some(Boolean) : results.every(Boolean);
}

// ── Values ───────────────────────────────────────────────────────────────

export interface AutomationValueContext {
  now: number;
  timezone: string;
  triggerUserId: string | null;
  triggerRowId: string | null;
  /** Values of the record that triggered the run. */
  triggerValues: Record<string, JsonValue>;
}

/** Calendar day in a time zone as "YYYY-MM-DD". */
export function localDate(timestamp: number, timezone: string): string {
  const parts = zonedParts(timestamp, timezone);
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Replace `$token` placeholders with concrete values. */
export function resolveAutomationValue(
  value: JsonValue,
  context: AutomationValueContext,
): JsonValue {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const resolved = resolveAutomationValue(item, context);
      return Array.isArray(resolved) ? resolved : [resolved];
    });
  }
  if (!isRecord(value) || typeof value.$token !== 'string') return value;
  switch (value.$token as AutomationToken) {
    case 'now':
      return { start: new Date(context.now).toISOString(), end: null, includeTime: true };
    case 'today':
      return {
        start: `${localDate(context.now, context.timezone)}T00:00:00.000Z`,
        end: null,
        includeTime: false,
      };
    case 'trigger_user':
      return context.triggerUserId ? [context.triggerUserId] : [];
    case 'trigger_row':
      return context.triggerRowId ? [context.triggerRowId] : [];
    case 'copy':
      return typeof value.propertyId === 'string'
        ? (context.triggerValues[value.propertyId] ?? null)
        : null;
    case 'clear':
      return null;
    default:
      return null;
  }
}

/**
 * Fill `{{字段名}}` placeholders in a message. `lookup` returns display text for a
 * field name (or null when there is no such field, which leaves it as written).
 */
export function renderAutomationTemplate(
  template: string,
  lookup: (name: string) => string | null,
): string {
  return template.replace(/\{\{\s*([^{}]{1,80}?)\s*\}\}/g, (whole, name: string) => {
    const text = lookup(name);
    return text === null ? whole : text;
  });
}

/** Plain text for a cell value, for messages and notifications. */
export function automationDisplayText(
  value: JsonValue | undefined,
  names: ReadonlyMap<string, string> = new Map(),
): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (typeof value === 'number' || typeof value === 'string')
    return names.get(String(value)) ?? String(value);
  if (Array.isArray(value))
    return value
      .map((item) => automationDisplayText(item, names))
      .filter(Boolean)
      .join('、');
  if (typeof value.start === 'string') {
    const start = value.start;
    const withTime = value.includeTime === true;
    const format = (iso: string) =>
      withTime ? iso.slice(0, 16).replace('T', ' ') : iso.slice(0, 10);
    return typeof value.end === 'string' && value.end
      ? `${format(start)} → ${format(value.end)}`
      : format(start);
  }
  if (typeof value.name === 'string') return value.name;
  return '';
}

// ── Schedules ────────────────────────────────────────────────────────────

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function zonedParts(timestamp: number, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    weekday: 'short',
  }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '0';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** UTC timestamp of a wall-clock time in a time zone (DST gaps move forward). */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(guess, timezone);
    const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const next = guess + (wall - shown);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The next time a schedule fires strictly after `from`, or null when it never does. */
export function nextScheduleRun(
  schedule: AutomationSchedule,
  timezone: string,
  from: number,
): number | null {
  const zone = isValidTimeZone(timezone) ? timezone : 'UTC';
  const [hour = 9, minute = 0] = schedule.time.split(':').map(Number);
  if (schedule.frequency === 'hourly') {
    const parts = zonedParts(from, zone);
    for (let offset = 0; offset <= 2; offset += 1) {
      const candidate =
        zonedTimeToUtc(parts.year, parts.month, parts.day, parts.hour, minute, zone) +
        offset * 3_600_000;
      if (candidate > from) return candidate;
    }
    return null;
  }
  const start = zonedParts(from, zone);
  const base = Date.UTC(start.year, start.month - 1, start.day);
  for (let offset = 0; offset < 400; offset += 1) {
    const day = new Date(base + offset * 86_400_000);
    const year = day.getUTCFullYear();
    const month = day.getUTCMonth() + 1;
    const date = day.getUTCDate();
    const weekday = day.getUTCDay();
    if (schedule.frequency === 'weekly' && !schedule.weekdays.includes(weekday)) continue;
    if (
      schedule.frequency === 'monthly' &&
      date !== Math.min(schedule.dayOfMonth, daysInMonth(year, month))
    ) {
      continue;
    }
    const candidate = zonedTimeToUtc(year, month, date, hour, minute, zone);
    if (candidate > from) return candidate;
  }
  return null;
}

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** "每周一、周三 09:00" */
export function describeSchedule(schedule: AutomationSchedule): string {
  const minute = schedule.time.slice(3);
  switch (schedule.frequency) {
    case 'hourly':
      return `每小时第 ${Number(minute)} 分钟`;
    case 'daily':
      return `每天 ${schedule.time}`;
    case 'weekly':
      return `每${schedule.weekdays.map((day) => WEEKDAY_LABELS[day]).join('、')} ${schedule.time}`;
    case 'monthly':
      return `每月 ${schedule.dayOfMonth} 日 ${schedule.time}`;
  }
}

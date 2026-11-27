import {
  Activity,
  ArrowDown,
  ArrowUp,
  Bell,
  Clock3,
  Filter,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';

import {
  describeSchedule,
  type AutomationActionStep,
  type AutomationActionType,
  type AutomationConditionOp,
  type AutomationConditionRule,
  type AutomationDefinition,
  type AutomationSchedule,
  type AutomationTriggerType,
  type DatabaseAutomationRunSummary,
  type DatabaseAutomationSummary,
  type DatabasePropertySummary,
  type DatabasePropertyType,
  type DatabaseSnapshot,
  type JsonValue,
  type OrganizationMemberSummary,
} from '@rdocs/shared';

import {
  createDatabaseAutomation,
  deleteDatabaseAutomation,
  getDatabase,
  getNotionConnection,
  getNotionDatabaseSchema,
  searchNotion,
  type NotionPropertySchema,
  type NotionSearchResult,
  listDatabaseAutomations,
  listOrganizationDatabases,
  listOrganizationMembers,
  runDatabaseAutomation,
  updateDatabaseAutomation,
} from './api';
import { confirmDialog } from './dialogs';
import { cachedRequest } from './request-cache';

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTriggerType, string> = {
  row_created: '新建记录时',
  row_updated: '任意字段修改时',
  property_changed: '指定字段修改时',
  form_submitted: '表单提交时',
  manual: '手动运行',
  schedule: '定时运行',
};

export const AUTOMATION_ACTION_LABELS: Record<AutomationActionType, string> = {
  set_property: '设置字段',
  toggle_checkbox: '切换复选框',
  increment_number: '数字递增',
  archive_row: '归档这条记录',
  create_row: '新建记录',
  edit_rows: '修改记录',
  notify: '发送通知',
  webhook: '发送 Webhook',
  notion_create_page: '写入 Notion 数据库',
};

const ACTION_CHOICES: AutomationActionType[] = [
  'set_property',
  'create_row',
  'edit_rows',
  'notify',
  'toggle_checkbox',
  'increment_number',
  'archive_row',
  'webhook',
];

const OP_LABELS: Record<AutomationConditionOp, string> = {
  eq: '等于',
  neq: '不等于',
  contains: '包含',
  not_contains: '不包含',
  is_empty: '为空',
  not_empty: '不为空',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  is_checked: '已勾选',
  not_checked: '未勾选',
};

const VALUELESS_OPS = new Set<AutomationConditionOp>([
  'is_empty',
  'not_empty',
  'is_checked',
  'not_checked',
]);

const RUN_STATUS_LABELS: Record<DatabaseAutomationRunSummary['status'], string> = {
  running: '运行中',
  succeeded: '成功',
  failed: '失败',
  skipped: '条件不满足',
};

const WEEKDAY_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

const READ_ONLY_TYPES = new Set<DatabasePropertyType>([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'button',
  'unique_id',
]);

function writable(properties: readonly DatabasePropertySummary[]): DatabasePropertySummary[] {
  return properties.filter((property) => !READ_ONLY_TYPES.has(property.type));
}

function opsFor(type: DatabasePropertyType | undefined): AutomationConditionOp[] {
  switch (type) {
    case 'checkbox':
      return ['is_checked', 'not_checked'];
    case 'number':
    case 'unique_id':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'is_empty', 'not_empty'];
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return ['eq', 'lt', 'gt', 'is_empty', 'not_empty'];
    case 'select':
    case 'status':
      return ['eq', 'neq', 'is_empty', 'not_empty'];
    case 'multi_select':
    case 'person':
    case 'relation':
    case 'files':
    case 'created_by':
    case 'last_edited_by':
      return ['contains', 'not_contains', 'is_empty', 'not_empty'];
    default:
      return ['eq', 'neq', 'contains', 'not_contains', 'is_empty', 'not_empty'];
  }
}

function optionNames(property: DatabasePropertySummary | undefined): string[] {
  const options = property?.config.options;
  if (!Array.isArray(options)) return [];
  return options
    .map((option) =>
      typeof option === 'string'
        ? option
        : option &&
            typeof option === 'object' &&
            !Array.isArray(option) &&
            typeof option.name === 'string'
          ? option.name
          : '',
    )
    .filter(Boolean);
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function blankDefinition(properties: readonly DatabasePropertySummary[]): AutomationDefinition {
  const status = properties.find(
    (property) => property.type === 'status' || property.type === 'select',
  );
  return {
    trigger: { type: 'property_changed', propertyIds: status ? [status.id] : [], schedule: null },
    conditions: { match: 'all', rules: [] },
    actions: [{ type: 'set_property', config: {} }],
    timezone: browserTimeZone(),
  };
}

function defaultConfig(type: AutomationActionType): Record<string, JsonValue> {
  switch (type) {
    case 'notify':
      return { notifyTriggerUser: true, message: '{{标题}}' };
    case 'increment_number':
      return { increment: 1 };
    case 'create_row':
    case 'edit_rows':
      return { values: {} };
    case 'webhook':
      return { url: 'https://' };
    default:
      return {};
  }
}

function summarize(
  definition: AutomationDefinition,
  properties: readonly DatabasePropertySummary[],
): string {
  const { trigger } = definition;
  let when: string = AUTOMATION_TRIGGER_LABELS[trigger.type];
  if (trigger.type === 'property_changed') {
    const names = trigger.propertyIds
      .map((id) => properties.find((property) => property.id === id)?.name)
      .filter(Boolean);
    when = names.length ? `「${names.join('、')}」修改时` : when;
  }
  if (trigger.type === 'schedule' && trigger.schedule) when = describeSchedule(trigger.schedule);
  const actions = definition.actions
    .map((action) => AUTOMATION_ACTION_LABELS[action.type])
    .join(' + ');
  return `${when} → ${actions || '无动作'}`;
}

// ── Value editor ─────────────────────────────────────────────────────────

type ValueMode = 'literal' | 'copy' | 'today' | 'now' | 'trigger_user' | 'trigger_row' | 'clear';

function valueMode(value: JsonValue | undefined): ValueMode {
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof value.$token === 'string'
  ) {
    return value.$token as ValueMode;
  }
  return 'literal';
}

function modesFor(type: DatabasePropertyType): ValueMode[] {
  const modes: ValueMode[] = ['literal', 'copy'];
  if (type === 'date') modes.push('today', 'now');
  if (type === 'person') modes.push('trigger_user');
  if (type === 'relation') modes.push('trigger_row');
  modes.push('clear');
  return type === 'relation' ? ['trigger_row', 'copy', 'clear'] : modes;
}

const MODE_LABELS: Record<ValueMode, string> = {
  literal: '固定值',
  copy: '复制触发记录的字段',
  today: '今天',
  now: '现在',
  trigger_user: '触发者',
  trigger_row: '触发这次运行的记录',
  clear: '清空',
};

function ValueInput({
  property,
  value,
  onChange,
  sourceProperties,
  members,
}: {
  property: DatabasePropertySummary;
  value: JsonValue | undefined;
  onChange: (value: JsonValue) => void;
  /** Fields of the record that triggered the run, for "copy". */
  sourceProperties: readonly DatabasePropertySummary[];
  members: readonly OrganizationMemberSummary[];
}) {
  const mode = valueMode(value);
  const modes = modesFor(property.type);
  const setMode = (next: ValueMode) => {
    if (next === 'literal') onChange(property.type === 'checkbox' ? true : null);
    else if (next === 'copy')
      onChange({ $token: 'copy', propertyId: sourceProperties[0]?.id ?? '' });
    else onChange({ $token: next });
  };
  let literal: ReactNode = null;
  if (mode === 'literal') {
    const options = optionNames(property);
    if (property.type === 'checkbox') {
      literal = (
        <select
          value={value === true ? 'true' : 'false'}
          onChange={(event) => onChange(event.target.value === 'true')}
        >
          <option value="true">勾选</option>
          <option value="false">取消勾选</option>
        </select>
      );
    } else if ((property.type === 'select' || property.type === 'status') && options.length) {
      literal = (
        <select
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || null)}
        >
          <option value="">请选择</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      );
    } else if (property.type === 'multi_select' && options.length) {
      const selected = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
      literal = (
        <span className="automation-chip-picker">
          {options.map((option) => (
            <label key={option}>
              <input
                type="checkbox"
                checked={selected.includes(option)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, option]
                      : selected.filter((item) => item !== option),
                  )
                }
              />
              {option}
            </label>
          ))}
        </span>
      );
    } else if (property.type === 'person') {
      const selected = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
      literal = (
        <span className="automation-chip-picker">
          {members.map((member) => (
            <label key={member.userId}>
              <input
                type="checkbox"
                checked={selected.includes(member.userId)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...selected, member.userId]
                      : selected.filter((item) => item !== member.userId),
                  )
                }
              />
              {member.displayName}
            </label>
          ))}
        </span>
      );
    } else if (property.type === 'date') {
      const start =
        value &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        typeof value.start === 'string'
          ? value.start.slice(0, 10)
          : '';
      literal = (
        <input
          type="date"
          value={start}
          onChange={(event) =>
            onChange(
              event.target.value
                ? { start: `${event.target.value}T00:00:00.000Z`, includeTime: false }
                : null,
            )
          }
        />
      );
    } else if (property.type === 'number') {
      literal = (
        <input
          type="number"
          value={typeof value === 'number' ? value : ''}
          onChange={(event) =>
            onChange(event.target.value === '' ? null : Number(event.target.value))
          }
        />
      );
    } else {
      literal = (
        <input
          value={typeof value === 'string' ? value : ''}
          placeholder="输入值"
          onChange={(event) => onChange(event.target.value)}
        />
      );
    }
  }
  return (
    <span className="automation-value-input">
      {modes.length > 1 ? (
        <select
          value={mode}
          aria-label="值的来源"
          onChange={(event) => setMode(event.target.value as ValueMode)}
        >
          {modes.map((candidate) => (
            <option key={candidate} value={candidate}>
              {MODE_LABELS[candidate]}
            </option>
          ))}
        </select>
      ) : null}
      {literal}
      {mode === 'copy' ? (
        <select
          aria-label="复制哪个字段"
          value={
            value && typeof value === 'object' && !Array.isArray(value)
              ? String(value.propertyId ?? '')
              : ''
          }
          onChange={(event) => onChange({ $token: 'copy', propertyId: event.target.value })}
        >
          {sourceProperties.map((source) => (
            <option key={source.id} value={source.id}>
              {source.name}
            </option>
          ))}
        </select>
      ) : null}
    </span>
  );
}

// ── Building blocks ──────────────────────────────────────────────────────

function RuleEditor({
  rules,
  match,
  properties,
  sourceProperties,
  members,
  onChange,
  emptyText,
}: {
  rules: AutomationConditionRule[];
  match: 'all' | 'any';
  properties: readonly DatabasePropertySummary[];
  sourceProperties: readonly DatabasePropertySummary[];
  members: readonly OrganizationMemberSummary[];
  onChange: (next: { match: 'all' | 'any'; rules: AutomationConditionRule[] }) => void;
  emptyText: string;
}) {
  const update = (index: number, rule: AutomationConditionRule) =>
    onChange({
      match,
      rules: rules.map((current, position) => (position === index ? rule : current)),
    });
  return (
    <div className="automation-rules">
      {rules.length > 1 ? (
        <label className="automation-inline">
          满足
          <select
            value={match}
            onChange={(event) => onChange({ match: event.target.value as 'all' | 'any', rules })}
          >
            <option value="all">全部条件</option>
            <option value="any">任一条件</option>
          </select>
        </label>
      ) : null}
      {rules.map((rule, index) => {
        const property = properties.find((candidate) => candidate.id === rule.propertyId);
        const ops = opsFor(property?.type);
        return (
          <div className="automation-rule" key={index}>
            <select
              aria-label="条件字段"
              value={rule.propertyId}
              onChange={(event) => {
                const next = properties.find((candidate) => candidate.id === event.target.value);
                update(index, {
                  propertyId: event.target.value,
                  op: opsFor(next?.type)[0] ?? 'eq',
                });
              }}
            >
              {properties.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </option>
              ))}
            </select>
            <select
              aria-label="条件运算"
              value={rule.op}
              onChange={(event) =>
                update(index, { ...rule, op: event.target.value as AutomationConditionOp })
              }
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {OP_LABELS[op]}
                </option>
              ))}
            </select>
            {property && !VALUELESS_OPS.has(rule.op) ? (
              <ValueInput
                property={
                  property.type === 'multi_select' ? { ...property, type: 'select' } : property
                }
                value={rule.value}
                sourceProperties={sourceProperties}
                members={members}
                onChange={(value) => update(index, { ...rule, value })}
              />
            ) : null}
            <button
              type="button"
              className="automation-icon-button"
              aria-label="删除条件"
              onClick={() =>
                onChange({ match, rules: rules.filter((_, position) => position !== index) })
              }
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {!rules.length ? <p className="automation-hint">{emptyText}</p> : null}
      <button
        type="button"
        className="automation-add"
        disabled={!properties.length}
        onClick={() =>
          onChange({
            match,
            rules: [
              ...rules,
              { propertyId: properties[0]!.id, op: opsFor(properties[0]!.type)[0] ?? 'eq' },
            ],
          })
        }
      >
        <Plus size={14} /> 添加条件
      </button>
    </div>
  );
}

function FieldValues({
  values,
  properties,
  sourceProperties,
  members,
  onChange,
}: {
  values: Record<string, JsonValue>;
  properties: readonly DatabasePropertySummary[];
  sourceProperties: readonly DatabasePropertySummary[];
  members: readonly OrganizationMemberSummary[];
  onChange: (values: Record<string, JsonValue>) => void;
}) {
  const targets = writable(properties);
  const used = Object.keys(values);
  const unused = targets.filter((property) => !used.includes(property.id));
  return (
    <div className="automation-fields">
      {used.map((propertyId) => {
        const property = targets.find((candidate) => candidate.id === propertyId);
        if (!property) return null;
        return (
          <div className="automation-rule" key={propertyId}>
            <span className="automation-field-name">{property.name}</span>
            <ValueInput
              property={property}
              value={values[propertyId]}
              sourceProperties={sourceProperties}
              members={members}
              onChange={(value) => onChange({ ...values, [propertyId]: value })}
            />
            <button
              type="button"
              className="automation-icon-button"
              aria-label={`不设置${property.name}`}
              onClick={() => {
                const { [propertyId]: _removed, ...rest } = values;
                onChange(rest);
              }}
            >
              <X size={14} />
            </button>
          </div>
        );
      })}
      {unused.length ? (
        <select
          className="automation-add-select"
          value=""
          aria-label="添加字段"
          onChange={(event) => {
            if (!event.target.value) return;
            const property = targets.find((candidate) => candidate.id === event.target.value);
            onChange({
              ...values,
              [event.target.value]: property?.type === 'checkbox' ? true : null,
            });
          }}
        >
          <option value="">＋ 设置字段…</option>
          {unused.map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function useTargetDatabase(
  organizationId: string,
  databaseId: string | undefined,
  fallback: DatabaseSnapshot,
) {
  const [target, setTarget] = useState<DatabaseSnapshot | null>(null);
  useEffect(() => {
    if (!databaseId || databaseId === fallback.database.id) {
      setTarget(null);
      return;
    }
    let active = true;
    void cachedRequest(`database:${databaseId}`, () => getDatabase(databaseId))
      .then((snapshot) => {
        if (active) setTarget(snapshot);
      })
      .catch(() => {
        if (active) setTarget(null);
      });
    return () => {
      active = false;
    };
  }, [databaseId, fallback.database.id, organizationId]);
  return target ?? fallback;
}

function NotionActionEditor({
  step,
  snapshot,
  onChange,
}: {
  step: AutomationActionStep;
  snapshot: DatabaseSnapshot;
  onChange: (step: AutomationActionStep) => void;
}) {
  const organizationId = snapshot.database.organizationId;
  const config = step.config;
  const databaseId = typeof config.notionDatabaseId === 'string' ? config.notionDatabaseId : '';
  const [databases, setDatabases] = useState<NotionSearchResult[]>([]);
  const [schema, setSchema] = useState<NotionPropertySchema[]>([]);
  const [error, setError] = useState<string | null>(null);
  const mapping = Array.isArray(config.properties)
    ? (config.properties as Array<{ name: string; type: string; value: JsonValue }>)
    : [];
  useEffect(() => {
    let active = true;
    void searchNotion(organizationId, '', 'database')
      .then((result) => active && setDatabases(result.results))
      .catch(
        (reason: unknown) =>
          active && setError(reason instanceof Error ? reason.message : '无法读取 Notion'),
      );
    return () => {
      active = false;
    };
  }, [organizationId]);
  useEffect(() => {
    if (!databaseId) {
      setSchema([]);
      return;
    }
    let active = true;
    void getNotionDatabaseSchema(organizationId, databaseId)
      .then(
        (result) => active && setSchema(result.properties.filter((property) => property.writable)),
      )
      .catch(
        (reason: unknown) =>
          active && setError(reason instanceof Error ? reason.message : '无法读取 Notion 数据库'),
      );
    return () => {
      active = false;
    };
  }, [databaseId, organizationId]);
  const setMapping = (name: string, type: string, value: JsonValue | undefined) => {
    const rest = mapping.filter((item) => item.name !== name);
    onChange({
      ...step,
      config: {
        ...config,
        properties: value === undefined ? rest : [...rest, { name, type, value }],
      },
    });
  };
  return (
    <div className="automation-action-body column">
      <label className="automation-inline">
        Notion 数据库
        <select
          value={databaseId}
          onChange={(event) =>
            onChange({ ...step, config: { notionDatabaseId: event.target.value, properties: [] } })
          }
        >
          <option value="">选择…</option>
          {databases.map((database) => (
            <option key={database.id} value={database.id}>
              {database.icon ? `${database.icon} ` : ''}
              {database.title}
            </option>
          ))}
        </select>
      </label>
      {schema.map((property) => {
        const current = mapping.find((item) => item.name === property.name);
        const value = current?.value;
        const mode =
          current === undefined
            ? 'skip'
            : value && typeof value === 'object' && !Array.isArray(value) && value.$token === 'copy'
              ? `copy:${String(value.propertyId ?? '')}`
              : 'literal';
        return (
          <div className="automation-rule" key={property.name}>
            <span className="automation-field-name">{property.name}</span>
            <select
              aria-label={`${property.name} 的来源`}
              value={mode}
              onChange={(event) => {
                const next = event.target.value;
                if (next === 'skip') setMapping(property.name, property.type, undefined);
                else if (next === 'literal')
                  setMapping(property.name, property.type, property.options[0] ?? '');
                else
                  setMapping(property.name, property.type, {
                    $token: 'copy',
                    propertyId: next.slice(5),
                  });
              }}
            >
              <option value="skip">不写入</option>
              {snapshot.properties.map((source) => (
                <option key={source.id} value={`copy:${source.id}`}>
                  复制「{source.name}」
                </option>
              ))}
              <option value="literal">固定值</option>
            </select>
            {mode === 'literal' ? (
              property.options.length ? (
                <select
                  aria-label={`${property.name} 的值`}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setMapping(property.name, property.type, event.target.value)}
                >
                  {property.options.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label={`${property.name} 的值`}
                  value={typeof value === 'string' ? value : ''}
                  onChange={(event) => setMapping(property.name, property.type, event.target.value)}
                />
              )
            ) : null}
          </div>
        );
      })}
      {error ? <p className="dialog-error">{error}</p> : null}
      {!databases.length && !error ? (
        <p className="automation-hint">
          没有可用的 Notion 数据库：请在 Notion 中把数据库连接到这个集成。
        </p>
      ) : null}
    </div>
  );
}

function ActionEditor({
  step,
  snapshot,
  databases,
  members,
  onChange,
}: {
  step: AutomationActionStep;
  snapshot: DatabaseSnapshot;
  databases: ReadonlyArray<{ id: string; title: string }>;
  members: readonly OrganizationMemberSummary[];
  onChange: (step: AutomationActionStep) => void;
}) {
  const config = step.config;
  const set = (patch: Record<string, JsonValue>) =>
    onChange({ ...step, config: { ...config, ...patch } });
  const targetId =
    typeof config.databaseId === 'string' && config.databaseId
      ? config.databaseId
      : snapshot.database.id;
  const target = useTargetDatabase(snapshot.database.organizationId, targetId, snapshot);
  const properties = snapshot.properties;
  const values =
    config.values && typeof config.values === 'object' && !Array.isArray(config.values)
      ? (config.values as Record<string, JsonValue>)
      : {};
  const databasePicker = (
    <label className="automation-inline">
      数据库
      <select
        value={targetId}
        onChange={(event) =>
          set({
            databaseId: event.target.value === snapshot.database.id ? '' : event.target.value,
            values: {},
            filter: { match: 'all', rules: [] },
          })
        }
      >
        <option value={snapshot.database.id}>当前数据库</option>
        {databases
          .filter((database) => database.id !== snapshot.database.id)
          .map((database) => (
            <option key={database.id} value={database.id}>
              {database.title || '未命名数据库'}
            </option>
          ))}
      </select>
    </label>
  );
  switch (step.type) {
    case 'set_property': {
      const targets = writable(properties);
      const property = targets.find((candidate) => candidate.id === config.targetPropertyId);
      return (
        <div className="automation-action-body">
          <select
            aria-label="要设置的字段"
            value={typeof config.targetPropertyId === 'string' ? config.targetPropertyId : ''}
            onChange={(event) =>
              onChange({ ...step, config: { targetPropertyId: event.target.value, value: null } })
            }
          >
            <option value="">选择字段…</option>
            {targets.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
          {property ? (
            <ValueInput
              property={property}
              value={config.value}
              sourceProperties={properties}
              members={members}
              onChange={(value) => set({ value })}
            />
          ) : null}
        </div>
      );
    }
    case 'toggle_checkbox':
    case 'increment_number': {
      const wanted = step.type === 'toggle_checkbox' ? 'checkbox' : 'number';
      return (
        <div className="automation-action-body">
          <select
            aria-label="目标字段"
            value={typeof config.targetPropertyId === 'string' ? config.targetPropertyId : ''}
            onChange={(event) => set({ targetPropertyId: event.target.value })}
          >
            <option value="">选择字段…</option>
            {properties
              .filter((property) => property.type === wanted)
              .map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
          </select>
          {step.type === 'increment_number' ? (
            <label className="automation-inline">
              增加
              <input
                type="number"
                value={typeof config.increment === 'number' ? config.increment : 1}
                onChange={(event) => set({ increment: Number(event.target.value) || 0 })}
              />
            </label>
          ) : null}
        </div>
      );
    }
    case 'archive_row':
      return <p className="automation-hint">把触发这次运行的记录移入已归档。</p>;
    case 'create_row':
      return (
        <div className="automation-action-body column">
          {databasePicker}
          <FieldValues
            values={values}
            properties={target.properties}
            sourceProperties={properties}
            members={members}
            onChange={(next) => set({ values: next })}
          />
        </div>
      );
    case 'edit_rows': {
      const filter =
        config.filter && typeof config.filter === 'object' && !Array.isArray(config.filter)
          ? (config.filter as { match?: 'all' | 'any'; rules?: AutomationConditionRule[] })
          : {};
      return (
        <div className="automation-action-body column">
          {databasePicker}
          <span className="automation-subheading">
            <Filter size={13} /> 修改哪些记录
          </span>
          <RuleEditor
            rules={filter.rules ?? []}
            match={filter.match ?? 'all'}
            properties={target.properties}
            sourceProperties={properties}
            members={members}
            emptyText="还没有筛选条件。"
            onChange={(next) => set({ filter: next as unknown as JsonValue })}
          />
          {!(filter.rules ?? []).length ? (
            <label className="automation-inline">
              <input
                type="checkbox"
                checked={config.allRows === true}
                onChange={(event) => set({ allRows: event.target.checked })}
              />
              修改这个数据库里的所有记录（最多 100 条）
            </label>
          ) : null}
          <span className="automation-subheading">
            <Pencil size={13} /> 改成
          </span>
          <FieldValues
            values={values}
            properties={target.properties}
            sourceProperties={properties}
            members={members}
            onChange={(next) => set({ values: next })}
          />
        </div>
      );
    }
    case 'notify': {
      const personProperties = properties.filter((property) =>
        ['person', 'created_by', 'last_edited_by'].includes(property.type),
      );
      const chosenProperties = Array.isArray(config.personPropertyIds)
        ? (config.personPropertyIds as string[])
        : [];
      const chosenUsers = Array.isArray(config.userIds) ? (config.userIds as string[]) : [];
      return (
        <div className="automation-action-body column">
          <span className="automation-subheading">
            <Bell size={13} /> 通知谁
          </span>
          <span className="automation-chip-picker">
            <label>
              <input
                type="checkbox"
                checked={config.notifyTriggerUser === true}
                onChange={(event) => set({ notifyTriggerUser: event.target.checked })}
              />
              触发者
            </label>
            {personProperties.map((property) => (
              <label key={property.id}>
                <input
                  type="checkbox"
                  checked={chosenProperties.includes(property.id)}
                  onChange={(event) =>
                    set({
                      personPropertyIds: event.target.checked
                        ? [...chosenProperties, property.id]
                        : chosenProperties.filter((id) => id !== property.id),
                    })
                  }
                />
                字段「{property.name}」里的人
              </label>
            ))}
            {members.map((member) => (
              <label key={member.userId}>
                <input
                  type="checkbox"
                  checked={chosenUsers.includes(member.userId)}
                  onChange={(event) =>
                    set({
                      userIds: event.target.checked
                        ? [...chosenUsers, member.userId]
                        : chosenUsers.filter((id) => id !== member.userId),
                    })
                  }
                />
                {member.displayName}
              </label>
            ))}
          </span>
          <textarea
            rows={2}
            maxLength={1000}
            value={typeof config.message === 'string' ? config.message : ''}
            placeholder="通知内容，可用 {{标题}}、{{字段名}} 引用记录的值"
            onChange={(event) => set({ message: event.target.value })}
          />
          <label className="automation-inline">
            <input
              type="checkbox"
              checked={config.email === true}
              onChange={(event) => set({ email: event.target.checked })}
            />
            同时发送邮件
          </label>
        </div>
      );
    }
    case 'webhook':
      return (
        <div className="automation-action-body column">
          <input
            type="url"
            aria-label="Webhook 地址"
            value={typeof config.url === 'string' ? config.url : ''}
            placeholder="https://"
            onChange={(event) => set({ url: event.target.value })}
          />
          <input
            type="password"
            aria-label="签名密钥"
            value={typeof config.secret === 'string' ? config.secret : ''}
            placeholder={
              config.hasSecret === true
                ? '已设置签名密钥，留空保持不变'
                : '签名密钥（可选，至少 16 个字符）'
            }
            onChange={(event) => {
              const { secret: _secret, ...rest } = config;
              onChange({
                ...step,
                config: event.target.value ? { ...rest, secret: event.target.value } : rest,
              });
            }}
          />
          <p className="automation-hint">
            以 JSON POST 触发记录；设置密钥后带 x-rdocs-signature-256 签名头。
          </p>
        </div>
      );
    case 'notion_create_page':
      return <NotionActionEditor step={step} snapshot={snapshot} onChange={onChange} />;
  }
}

function TriggerEditor({
  definition,
  properties,
  onChange,
}: {
  definition: AutomationDefinition;
  properties: readonly DatabasePropertySummary[];
  onChange: (definition: AutomationDefinition) => void;
}) {
  const { trigger } = definition;
  const schedule: AutomationSchedule = trigger.schedule ?? {
    frequency: 'daily',
    time: '09:00',
    weekdays: [1],
    dayOfMonth: 1,
  };
  const setTrigger = (patch: Partial<AutomationDefinition['trigger']>) =>
    onChange({ ...definition, trigger: { ...trigger, ...patch } });
  const setSchedule = (patch: Partial<AutomationSchedule>) =>
    setTrigger({ schedule: { ...schedule, ...patch } });
  return (
    <div className="automation-action-body column">
      <select
        aria-label="触发方式"
        value={trigger.type}
        onChange={(event) => {
          const type = event.target.value as AutomationTriggerType;
          setTrigger({ type, schedule: type === 'schedule' ? schedule : null });
        }}
      >
        {(Object.keys(AUTOMATION_TRIGGER_LABELS) as AutomationTriggerType[]).map((type) => (
          <option key={type} value={type}>
            {AUTOMATION_TRIGGER_LABELS[type]}
          </option>
        ))}
      </select>
      {trigger.type === 'property_changed' ? (
        <span className="automation-chip-picker">
          {properties.map((property) => (
            <label key={property.id}>
              <input
                type="checkbox"
                checked={trigger.propertyIds.includes(property.id)}
                onChange={(event) =>
                  setTrigger({
                    propertyIds: event.target.checked
                      ? [...trigger.propertyIds, property.id]
                      : trigger.propertyIds.filter((id) => id !== property.id),
                  })
                }
              />
              {property.name}
            </label>
          ))}
        </span>
      ) : null}
      {trigger.type === 'schedule' ? (
        <div className="automation-schedule">
          <select
            aria-label="频率"
            value={schedule.frequency}
            onChange={(event) =>
              setSchedule({ frequency: event.target.value as AutomationSchedule['frequency'] })
            }
          >
            <option value="hourly">每小时</option>
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
          </select>
          {schedule.frequency === 'weekly' ? (
            <span className="automation-weekdays">
              {WEEKDAY_SHORT.map((label, day) => (
                <button
                  key={day}
                  type="button"
                  className={schedule.weekdays.includes(day) ? 'active' : ''}
                  aria-pressed={schedule.weekdays.includes(day)}
                  onClick={() =>
                    setSchedule({
                      weekdays: schedule.weekdays.includes(day)
                        ? schedule.weekdays.filter((item) => item !== day)
                        : [...schedule.weekdays, day].sort(),
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </span>
          ) : null}
          {schedule.frequency === 'monthly' ? (
            <label className="automation-inline">
              每月
              <input
                type="number"
                min={1}
                max={31}
                value={schedule.dayOfMonth}
                onChange={(event) =>
                  setSchedule({
                    dayOfMonth: Math.min(31, Math.max(1, Number(event.target.value) || 1)),
                  })
                }
              />
              日
            </label>
          ) : null}
          {schedule.frequency === 'hourly' ? (
            <label className="automation-inline">
              第
              <input
                type="number"
                min={0}
                max={59}
                value={Number(schedule.time.slice(3))}
                onChange={(event) =>
                  setSchedule({
                    time: `00:${String(Math.min(59, Math.max(0, Number(event.target.value) || 0))).padStart(2, '0')}`,
                  })
                }
              />
              分钟
            </label>
          ) : (
            <input
              type="time"
              aria-label="时间"
              value={schedule.time}
              onChange={(event) => setSchedule({ time: event.target.value || '09:00' })}
            />
          )}
          <small className="automation-hint">时区：{definition.timezone}</small>
        </div>
      ) : null}
      {trigger.type === 'manual' ? (
        <p className="automation-hint">在下方选择一条记录后点「运行」。</p>
      ) : null}
      {trigger.type === 'schedule' ? (
        <p className="automation-hint">
          设置了条件、或包含修改「这条记录」的动作时，会对每条满足条件的记录各执行一次（每次最多 50
          条）。
        </p>
      ) : null}
    </div>
  );
}

// ── Dialog ───────────────────────────────────────────────────────────────

interface Draft {
  id: string | null;
  name: string;
  definition: AutomationDefinition;
}

export function DatabaseAutomationDialog({
  snapshot,
  onChanged,
  onClose,
}: {
  snapshot: DatabaseSnapshot;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [automations, setAutomations] = useState<DatabaseAutomationSummary[]>([]);
  const [runs, setRuns] = useState<DatabaseAutomationRunSummary[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [databases, setDatabases] = useState<Array<{ id: string; title: string }>>([]);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [notionConnected, setNotionConnected] = useState(false);
  const [manualRowId, setManualRowId] = useState(snapshot.rows[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const organizationId = snapshot.database.organizationId;

  const load = useCallback(async () => {
    const result = await listDatabaseAutomations(snapshot.database.id);
    setAutomations(result.automations);
    setRuns(result.runs);
    return result.automations;
  }, [snapshot.database.id]);

  useEffect(() => {
    let active = true;
    void load()
      .then((list) => {
        if (!active) return;
        const first = list[0];
        setDraft(
          first
            ? { id: first.id, name: first.name, definition: first.definition }
            : { id: null, name: '新自动化', definition: blankDefinition(snapshot.properties) },
        );
      })
      .catch(
        (reason: unknown) =>
          active && setError(reason instanceof Error ? reason.message : '无法读取自动化'),
      );
    void listOrganizationDatabases(organizationId)
      .then(
        (result) =>
          active &&
          setDatabases(
            result.databases.map((database) => ({
              id: database.id,
              title: (database as { title?: string }).title ?? '',
            })),
          ),
      )
      .catch(() => undefined);
    void getNotionConnection(organizationId)
      .then((result) => active && setNotionConnected(result.connected))
      .catch(() => undefined);
    void cachedRequest(`members:${organizationId}`, () => listOrganizationMembers(organizationId))
      .then(
        (result) =>
          active && setMembers(result.members.filter((member) => member.status === 'active')),
      )
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [load, organizationId, snapshot.properties]);

  const selected = automations.find((automation) => automation.id === draft?.id) ?? null;
  const selectedRuns = useMemo(
    () => runs.filter((run) => !draft?.id || run.automationId === draft.id).slice(0, 30),
    [draft?.id, runs],
  );

  const save = async () => {
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = draft.id
        ? await updateDatabaseAutomation(snapshot.database.id, draft.id, {
            name: draft.name,
            definition: draft.definition,
          })
        : await createDatabaseAutomation(snapshot.database.id, {
            name: draft.name,
            definition: draft.definition,
          });
      await load();
      setDraft({
        id: result.automation.id,
        name: result.automation.name,
        definition: result.automation.definition,
      });
      setNotice('已保存');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存自动化');
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (automation: DatabaseAutomationSummary) => {
    if (busy) return;
    setBusy(true);
    try {
      await updateDatabaseAutomation(snapshot.database.id, automation.id, {
        enabled: !automation.enabled,
      });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新自动化');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!selected || busy) return;
    if (
      !(await confirmDialog({
        title: '删除自动化',
        message: `删除自动化“${selected.name}”及其运行记录？`,
        confirmLabel: '删除',
        danger: true,
      }))
    ) {
      return;
    }
    setBusy(true);
    try {
      await deleteDatabaseAutomation(snapshot.database.id, selected.id);
      const list = await load();
      const first = list[0];
      setDraft(
        first
          ? { id: first.id, name: first.name, definition: first.definition }
          : { id: null, name: '新自动化', definition: blankDefinition(snapshot.properties) },
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除自动化');
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!selected || busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await runDatabaseAutomation(
        snapshot.database.id,
        selected.id,
        selected.definition.trigger.type === 'manual' ? manualRowId : undefined,
      );
      await load();
      await onChanged();
      setNotice(
        result.run ? `运行结果：${RUN_STATUS_LABELS[result.run.status]}` : '没有满足条件的记录',
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法运行自动化');
    } finally {
      setBusy(false);
    }
  };

  const setDefinition = (definition: AutomationDefinition) =>
    draft && setDraft({ ...draft, definition });
  const actions = draft?.definition.actions ?? [];
  const setActions = (next: AutomationActionStep[]) =>
    draft && setDraft({ ...draft, definition: { ...draft.definition, actions: next } });
  const dirty =
    Boolean(draft) &&
    (!selected ||
      selected.name !== draft?.name ||
      JSON.stringify(selected.definition) !== JSON.stringify(draft?.definition));

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        className="rdocs-dialog automation-builder"
        role="dialog"
        aria-modal="true"
        aria-label="自动化"
      >
        <header className="automation-builder-header">
          <div>
            <h2>
              <Zap size={18} /> 自动化
            </h2>
            <p>当某件事发生时，自动修改记录、新建记录、通知成员或调用外部服务。</p>
          </div>
          <button
            type="button"
            className="automation-icon-button"
            aria-label="关闭"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>
        <div className="automation-builder-body">
          <aside className="automation-list">
            {automations.map((automation) => (
              <div
                key={automation.id}
                className={`automation-list-item${draft?.id === automation.id ? ' active' : ''}`}
              >
                <button
                  type="button"
                  className="automation-list-open"
                  onClick={() =>
                    setDraft({
                      id: automation.id,
                      name: automation.name,
                      definition: automation.definition,
                    })
                  }
                >
                  <strong>{automation.name}</strong>
                  <small>{summarize(automation.definition, snapshot.properties)}</small>
                  {automation.nextRunAt ? (
                    <small>
                      <Clock3 size={11} /> 下次 {new Date(automation.nextRunAt).toLocaleString()}
                    </small>
                  ) : null}
                </button>
                <label
                  className="automation-switch"
                  title={automation.enabled ? '已启用' : '已暂停'}
                >
                  <input
                    type="checkbox"
                    checked={automation.enabled}
                    disabled={busy}
                    aria-label={`${automation.enabled ? '暂停' : '启用'}${automation.name}`}
                    onChange={() => void toggle(automation)}
                  />
                  <span />
                </label>
              </div>
            ))}
            <button
              type="button"
              className="automation-add"
              onClick={() =>
                setDraft({
                  id: null,
                  name: '新自动化',
                  definition: blankDefinition(snapshot.properties),
                })
              }
            >
              <Plus size={14} /> 新建自动化
            </button>
          </aside>
          {draft ? (
            <div className="automation-editor">
              <input
                className="automation-name"
                aria-label="自动化名称"
                value={draft.name}
                maxLength={100}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <section className="automation-step">
                <h3>当…</h3>
                <TriggerEditor
                  definition={draft.definition}
                  properties={snapshot.properties}
                  onChange={setDefinition}
                />
              </section>
              <section className="automation-step">
                <h3>如果…</h3>
                <RuleEditor
                  rules={draft.definition.conditions.rules}
                  match={draft.definition.conditions.match}
                  properties={snapshot.properties}
                  sourceProperties={snapshot.properties}
                  members={members}
                  emptyText="不设条件：每次触发都执行。"
                  onChange={(conditions) => setDefinition({ ...draft.definition, conditions })}
                />
              </section>
              <section className="automation-step">
                <h3>执行…</h3>
                {actions.map((step, index) => (
                  <div className="automation-action" key={index}>
                    <div className="automation-action-head">
                      <span className="automation-step-number">{index + 1}</span>
                      <select
                        aria-label="动作"
                        value={step.type}
                        onChange={(event) => {
                          const type = event.target.value as AutomationActionType;
                          setActions(
                            actions.map((current, position) =>
                              position === index ? { type, config: defaultConfig(type) } : current,
                            ),
                          );
                        }}
                      >
                        {ACTION_CHOICES.map((type) => (
                          <option key={type} value={type}>
                            {AUTOMATION_ACTION_LABELS[type]}
                          </option>
                        ))}
                        {notionConnected || step.type === 'notion_create_page' ? (
                          <option value="notion_create_page">
                            {AUTOMATION_ACTION_LABELS.notion_create_page}
                          </option>
                        ) : null}
                      </select>
                      <span className="automation-action-tools">
                        <button
                          type="button"
                          className="automation-icon-button"
                          aria-label="上移"
                          disabled={index === 0}
                          onClick={() => {
                            const next = [...actions];
                            [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                            setActions(next);
                          }}
                        >
                          <ArrowUp size={14} />
                        </button>
                        <button
                          type="button"
                          className="automation-icon-button"
                          aria-label="下移"
                          disabled={index === actions.length - 1}
                          onClick={() => {
                            const next = [...actions];
                            [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
                            setActions(next);
                          }}
                        >
                          <ArrowDown size={14} />
                        </button>
                        <button
                          type="button"
                          className="automation-icon-button"
                          aria-label="删除动作"
                          onClick={() =>
                            setActions(actions.filter((_, position) => position !== index))
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      </span>
                    </div>
                    <ActionEditor
                      step={step}
                      snapshot={snapshot}
                      databases={databases}
                      members={members}
                      onChange={(next) =>
                        setActions(
                          actions.map((current, position) => (position === index ? next : current)),
                        )
                      }
                    />
                  </div>
                ))}
                {actions.length < 10 ? (
                  <button
                    type="button"
                    className="automation-add"
                    onClick={() => setActions([...actions, { type: 'set_property', config: {} }])}
                  >
                    <Plus size={14} /> 添加动作
                  </button>
                ) : null}
              </section>
              {error ? (
                <p className="dialog-error" role="alert">
                  {error}
                </p>
              ) : null}
              {notice ? <p className="automation-notice">{notice}</p> : null}
              <footer className="automation-editor-footer">
                {selected ? (
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    onClick={() => void remove()}
                  >
                    <Trash2 size={14} /> 删除
                  </button>
                ) : null}
                <span className="automation-footer-spacer" />
                {selected && !dirty && selected.definition.trigger.type === 'manual' ? (
                  <select
                    aria-label="运行哪条记录"
                    value={manualRowId}
                    onChange={(event) => setManualRowId(event.target.value)}
                  >
                    {snapshot.rows.map((row) => (
                      <option key={row.id} value={row.id}>
                        {String(
                          row.values[
                            snapshot.properties.find((property) => property.type === 'title')?.id ??
                              ''
                          ] ?? '未命名',
                        )}
                      </option>
                    ))}
                  </select>
                ) : null}
                {selected &&
                !dirty &&
                ['manual', 'schedule'].includes(selected.definition.trigger.type) ? (
                  <button
                    type="button"
                    disabled={
                      busy || (selected.definition.trigger.type === 'manual' && !manualRowId)
                    }
                    onClick={() => void run()}
                  >
                    <Play size={14} />{' '}
                    {selected.definition.trigger.type === 'schedule' ? '立即运行一次' : '运行'}
                  </button>
                ) : null}
                <button
                  className="primary-button"
                  type="button"
                  disabled={busy || !dirty}
                  onClick={() => void save()}
                >
                  {busy ? '保存中…' : draft.id ? '保存修改' : '创建自动化'}
                </button>
              </footer>
              {selected ? (
                <details
                  className="automation-runs"
                  open={selectedRuns.some((item) => item.status === 'failed')}
                >
                  <summary>
                    <Activity size={14} /> 运行记录 · {selectedRuns.length}
                  </summary>
                  {selectedRuns.map((item) => (
                    <div key={item.id} className="automation-run">
                      <span className={`automation-run-status ${item.status}`}>
                        {RUN_STATUS_LABELS[item.status]}
                      </span>
                      <time>{new Date(item.startedAt).toLocaleString()}</time>
                      <small>
                        {item.errorMessage || (item.status === 'succeeded' ? '完成' : '')}
                      </small>
                    </div>
                  ))}
                  {!selectedRuns.length ? <p className="automation-hint">还没有运行过。</p> : null}
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}

import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DatabasePropertySummary, JsonValue, OrganizationMemberSummary } from '@rdocs/shared';

import { listOrganizationMembers } from './api';
import {
  cellDayKey,
  filterOperatorLabel,
  filterOperatorsFor,
  RELATIVE_DATE_LABELS,
  type DatabaseFilterOperator,
  type DatabaseViewFilter,
  type DatabaseViewSort,
  type RelativeDateToken,
} from './database-view';
import { cachedRequest } from './request-cache';

const VALUELESS = new Set<DatabaseFilterOperator>(['is_empty', 'is_not_empty']);
const PERSON_TYPES = new Set(['person', 'created_by', 'last_edited_by']);
const DATE_TYPES = new Set(['date', 'created_time', 'last_edited_time']);

function optionNames(property: DatabasePropertySummary): string[] {
  const options = property.config.options;
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

function defaultValue(property: DatabasePropertySummary | undefined): JsonValue {
  if (!property) return '';
  if (property.type === 'checkbox') return true;
  if (DATE_TYPES.has(property.type)) return { $relative: 'today' };
  if (PERSON_TYPES.has(property.type)) return { $me: true };
  const options = optionNames(property);
  return options[0] ?? '';
}

function useMembers(organizationId: string, needed: boolean): OrganizationMemberSummary[] {
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  useEffect(() => {
    if (!needed) return;
    let active = true;
    void cachedRequest(`members:${organizationId}`, () => listOrganizationMembers(organizationId))
      .then(
        (result) =>
          active && setMembers(result.members.filter((member) => member.status === 'active')),
      )
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [needed, organizationId]);
  return members;
}

function FilterValue({
  property,
  value,
  members,
  onChange,
}: {
  property: DatabasePropertySummary;
  value: JsonValue;
  members: readonly OrganizationMemberSummary[];
  onChange: (value: JsonValue) => void;
}) {
  const [draft, setDraft] = useState(
    typeof value === 'string' || typeof value === 'number' ? String(value) : '',
  );
  useEffect(() => {
    setDraft(typeof value === 'string' || typeof value === 'number' ? String(value) : '');
  }, [value]);
  if (property.type === 'checkbox') {
    return (
      <select
        aria-label="筛选值"
        value={value === false ? 'false' : 'true'}
        onChange={(event) => onChange(event.target.value === 'true')}
      >
        <option value="true">已勾选</option>
        <option value="false">未勾选</option>
      </select>
    );
  }
  const options = optionNames(property);
  if (['select', 'status', 'multi_select'].includes(property.type) && options.length) {
    return (
      <select
        aria-label="筛选值"
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (PERSON_TYPES.has(property.type)) {
    const current =
      value && typeof value === 'object' && !Array.isArray(value) && value.$me === true
        ? '$me'
        : typeof value === 'string'
          ? value
          : '$me';
    return (
      <select
        aria-label="筛选值"
        value={current}
        onChange={(event) =>
          onChange(event.target.value === '$me' ? { $me: true } : event.target.value)
        }
      >
        <option value="$me">我</option>
        {members.map((member) => (
          <option key={member.userId} value={member.userId}>
            {member.displayName}
          </option>
        ))}
      </select>
    );
  }
  if (DATE_TYPES.has(property.type)) {
    const relative =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof value.$relative === 'string'
        ? (value.$relative as RelativeDateToken)
        : null;
    return (
      <>
        <select
          aria-label="日期"
          value={relative ?? 'exact'}
          onChange={(event) =>
            onChange(
              event.target.value === 'exact'
                ? {
                    start: `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`,
                    includeTime: false,
                  }
                : { $relative: event.target.value },
            )
          }
        >
          {(Object.keys(RELATIVE_DATE_LABELS) as RelativeDateToken[]).map((token) => (
            <option key={token} value={token}>
              {RELATIVE_DATE_LABELS[token]}
            </option>
          ))}
          <option value="exact">指定日期</option>
        </select>
        {!relative ? (
          <input
            type="date"
            aria-label="指定日期"
            value={cellDayKey(value)}
            onChange={(event) =>
              event.target.value &&
              onChange({ start: `${event.target.value}T00:00:00.000Z`, includeTime: false })
            }
          />
        ) : null}
      </>
    );
  }
  return (
    <input
      aria-label="筛选值"
      type={property.type === 'number' ? 'number' : 'text'}
      value={draft}
      placeholder="输入值"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onChange(property.type === 'number' && draft !== '' ? Number(draft) : draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter')
          onChange(property.type === 'number' && draft !== '' ? Number(draft) : draft);
      }}
    />
  );
}

export function DatabaseFilterPanel({
  filters,
  mode,
  properties,
  organizationId,
  canEdit,
  onChange,
}: {
  filters: DatabaseViewFilter[];
  mode: 'and' | 'or';
  properties: DatabasePropertySummary[];
  organizationId: string;
  canEdit: boolean;
  onChange: (filters: DatabaseViewFilter[], mode: 'and' | 'or') => void;
}) {
  const needsMembers = filters.some((filter) =>
    PERSON_TYPES.has(properties.find((property) => property.id === filter.propertyId)?.type ?? ''),
  );
  const members = useMembers(organizationId, needsMembers);
  const update = (index: number, next: DatabaseViewFilter) =>
    onChange(
      filters.map((filter, position) => (position === index ? next : filter)),
      mode,
    );
  return (
    <div className="database-view-popover database-filter-panel">
      {filters.map((filter, index) => {
        const property = properties.find((candidate) => candidate.id === filter.propertyId);
        const operators = filterOperatorsFor(property?.type ?? 'text');
        return (
          <div className="database-filter-row" key={index}>
            <span className="database-filter-join">
              {index === 0 ? (
                '当'
              ) : index === 1 ? (
                <select
                  aria-label="条件关系"
                  disabled={!canEdit}
                  value={mode}
                  onChange={(event) =>
                    onChange(filters, event.target.value === 'or' ? 'or' : 'and')
                  }
                >
                  <option value="and">且</option>
                  <option value="or">或</option>
                </select>
              ) : mode === 'or' ? (
                '或'
              ) : (
                '且'
              )}
            </span>
            <select
              aria-label="筛选字段"
              disabled={!canEdit}
              value={filter.propertyId}
              onChange={(event) => {
                const next = properties.find((candidate) => candidate.id === event.target.value);
                update(index, {
                  propertyId: event.target.value,
                  operator: filterOperatorsFor(next?.type ?? 'text')[0] ?? 'contains',
                  value: defaultValue(next),
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
              aria-label="筛选条件"
              disabled={!canEdit}
              value={operators.includes(filter.operator) ? filter.operator : operators[0]}
              onChange={(event) =>
                update(index, {
                  ...filter,
                  operator: event.target.value as DatabaseFilterOperator,
                  value: VALUELESS.has(event.target.value as DatabaseFilterOperator)
                    ? null
                    : (filter.value ?? defaultValue(property)),
                })
              }
            >
              {operators.map((operator) => (
                <option key={operator} value={operator}>
                  {filterOperatorLabel(operator, property?.type ?? 'text')}
                </option>
              ))}
            </select>
            {property && !VALUELESS.has(filter.operator) ? (
              <FilterValue
                property={property}
                value={filter.value}
                members={members}
                onChange={(value) => update(index, { ...filter, value })}
              />
            ) : null}
            {canEdit ? (
              <button
                type="button"
                className="database-filter-remove"
                aria-label="删除筛选"
                onClick={() =>
                  onChange(
                    filters.filter((_, position) => position !== index),
                    mode,
                  )
                }
              >
                <X size={14} />
              </button>
            ) : null}
          </div>
        );
      })}
      {!filters.length ? <p className="database-filter-empty">还没有筛选条件。</p> : null}
      {canEdit && properties.length ? (
        <button
          type="button"
          className="database-filter-add"
          onClick={() => {
            const property = properties[0]!;
            onChange(
              [
                ...filters,
                {
                  propertyId: property.id,
                  operator: filterOperatorsFor(property.type)[0] ?? 'contains',
                  value: defaultValue(property),
                },
              ],
              mode,
            );
          }}
        >
          <Plus size={14} /> 添加筛选
        </button>
      ) : null}
    </div>
  );
}

export function DatabaseSortPanel({
  sorts,
  properties,
  canEdit,
  onChange,
}: {
  sorts: DatabaseViewSort[];
  properties: DatabasePropertySummary[];
  canEdit: boolean;
  onChange: (sorts: DatabaseViewSort[]) => void;
}) {
  const unused = properties.filter(
    (property) => !sorts.some((sort) => sort.propertyId === property.id),
  );
  const move = (index: number, offset: number) => {
    const next = [...sorts];
    const [item] = next.splice(index, 1);
    next.splice(index + offset, 0, item!);
    onChange(next);
  };
  return (
    <div className="database-view-popover database-filter-panel">
      {sorts.map((sort, index) => (
        <div className="database-filter-row" key={sort.propertyId}>
          <span className="database-filter-join">{index === 0 ? '先按' : '再按'}</span>
          <select
            aria-label="排序字段"
            disabled={!canEdit}
            value={sort.propertyId}
            onChange={(event) =>
              onChange(
                sorts.map((item, position) =>
                  position === index ? { ...item, propertyId: event.target.value } : item,
                ),
              )
            }
          >
            {properties
              .filter((property) => property.id === sort.propertyId || unused.includes(property))
              .map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
          </select>
          <select
            aria-label="排序方向"
            disabled={!canEdit}
            value={sort.direction}
            onChange={(event) =>
              onChange(
                sorts.map((item, position) =>
                  position === index
                    ? {
                        ...item,
                        direction: event.target.value === 'descending' ? 'descending' : 'ascending',
                      }
                    : item,
                ),
              )
            }
          >
            <option value="ascending">升序</option>
            <option value="descending">降序</option>
          </select>
          {canEdit ? (
            <span className="database-sort-tools">
              <button
                type="button"
                aria-label="上移"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={13} />
              </button>
              <button
                type="button"
                aria-label="下移"
                disabled={index === sorts.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={13} />
              </button>
              <button
                type="button"
                aria-label="删除排序"
                onClick={() => onChange(sorts.filter((_, position) => position !== index))}
              >
                <X size={14} />
              </button>
            </span>
          ) : null}
        </div>
      ))}
      {!sorts.length ? <p className="database-filter-empty">还没有排序规则。</p> : null}
      {canEdit && unused.length ? (
        <button
          type="button"
          className="database-filter-add"
          onClick={() =>
            onChange([...sorts, { propertyId: unused[0]!.id, direction: 'ascending' }])
          }
        >
          <Plus size={14} /> 添加排序
        </button>
      ) : null}
    </div>
  );
}

import {
  Archive,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  Columns3,
  ExternalLink,
  FileText,
  GalleryHorizontal,
  KanbanSquare,
  LayoutDashboard,
  List,
  ListPlus,
  Lock,
  MapPinned,
  Plus,
  Rss,
  Search,
  Settings2,
  Table2,
  Trash2,
} from 'lucide-react';
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';

import type {
  AttachmentSummary,
  DatabasePropertySummary,
  DatabasePropertyType,
  DatabaseRowSummary,
  DatabaseSnapshot,
  DatabaseViewSummary,
  DatabaseViewType,
  JsonValue,
  OrganizationMemberSummary,
} from '@rdocs/shared';

import {
  createDatabaseProperty,
  createDatabaseRow,
  createDatabaseView,
  deleteDatabaseProperty,
  deleteDatabaseRow,
  deleteDatabaseView,
  getDatabase,
  listAttachments,
  listOrganizationDatabases,
  listOrganizationMembers,
  updateDatabase,
  updateDatabaseProperty,
  updateDatabaseRow,
  updateDatabaseView,
  uploadAttachment,
} from './api';
import {
  applyDatabaseView,
  databaseAggregationValue,
  databaseViewFilters,
  databaseViewSorts,
  groupDatabaseRows,
  orderedVisibleDatabaseProperties,
  type DatabaseAggregation,
  type DatabaseFilterOperator,
} from './database-view';

const PROPERTY_LABELS: Record<DatabasePropertyType, string> = {
  title: '标题',
  text: '文本',
  number: '数字',
  select: '单选',
  status: '状态',
  multi_select: '多选',
  date: '日期',
  formula: '公式',
  relation: '关系',
  rollup: '汇总',
  person: '人员',
  files: '文件',
  checkbox: '复选框',
  url: '网址',
  email: '邮箱',
  phone: '电话',
  created_time: '创建时间',
  created_by: '创建者',
  last_edited_time: '最后编辑时间',
  last_edited_by: '最后编辑者',
  button: '按钮',
  unique_id: '唯一 ID',
  place: '地点',
};

const VIEW_META: Record<
  DatabaseViewType,
  { label: string; icon: (props: { size?: number }) => ReactNode }
> = {
  table: { label: '表格', icon: Table2 },
  board: { label: '看板', icon: KanbanSquare },
  timeline: { label: '时间线', icon: Columns3 },
  calendar: { label: '日历', icon: CalendarDays },
  list: { label: '列表', icon: List },
  gallery: { label: '画廊', icon: GalleryHorizontal },
  chart: { label: '图表', icon: BarChart3 },
  dashboard: { label: '仪表盘', icon: LayoutDashboard },
  form: { label: '表单', icon: ListPlus },
  feed: { label: 'Feed', icon: Rss },
  map: { label: '地图', icon: MapPinned },
};

const EDITABLE_PROPERTY_TYPES = new Set<DatabasePropertyType>([
  'title',
  'text',
  'number',
  'select',
  'status',
  'multi_select',
  'date',
  'person',
  'files',
  'checkbox',
  'url',
  'email',
  'phone',
  'relation',
  'place',
]);

const FORM_PROPERTY_TYPES = new Set<DatabasePropertyType>([
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

function valueText(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(valueText).join(', ');
  if ('error' in value && typeof value.error === 'string') return value.error;
  if ('start' in value && typeof value.start === 'string') {
    return new Date(value.start).toLocaleDateString();
  }
  if ('name' in value && typeof value.name === 'string') return value.name;
  return JSON.stringify(value);
}

function optionNames(property: DatabasePropertySummary): string[] {
  const options = property.config.options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option === 'string') return [option];
    if (option && typeof option === 'object' && !Array.isArray(option)) {
      return typeof option.name === 'string' ? [option.name] : [];
    }
    return [];
  });
}

function titleProperty(properties: DatabasePropertySummary[]): DatabasePropertySummary | undefined {
  return properties.find((property) => property.type === 'title');
}

function rowTitle(row: DatabaseRowSummary, properties: DatabasePropertySummary[]): string {
  const property = titleProperty(properties);
  return property ? valueText(row.values[property.id]) || '未命名' : '未命名';
}

function dateInputValue(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value.slice(0, 10);
  if (value && !Array.isArray(value) && typeof value === 'object') {
    return typeof value.start === 'string' ? value.start.slice(0, 10) : '';
  }
  return '';
}

function toInputValue(property: DatabasePropertySummary, value: JsonValue | undefined): string {
  if (property.type === 'date') return dateInputValue(value);
  if (property.type === 'multi_select')
    return Array.isArray(value) ? value.map(valueText).join(', ') : '';
  if (property.type === 'place' && value && !Array.isArray(value) && typeof value === 'object') {
    return typeof value.name === 'string' ? value.name : '';
  }
  return valueText(value);
}

function fromInputValue(property: DatabasePropertySummary, value: string): JsonValue {
  if (property.type === 'number') return value === '' ? null : Number(value);
  if (property.type === 'date')
    return value ? { start: new Date(`${value}T00:00:00.000Z`).toISOString() } : null;
  if (property.type === 'multi_select') {
    return [
      ...new Set(
        value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ];
  }
  return value;
}

function RelationCell({
  property,
  value,
  disabled,
  onSave,
}: {
  property: DatabasePropertySummary;
  value: JsonValue | undefined;
  disabled: boolean;
  onSave: (value: JsonValue) => Promise<void>;
}) {
  const targetDatabaseId =
    typeof property.config.targetDatabaseId === 'string' ? property.config.targetDatabaseId : '';
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<DatabaseSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openPicker = async () => {
    if (disabled || !targetDatabaseId) return;
    setOpen(true);
    if (target || loading) return;
    setLoading(true);
    try {
      setTarget(await getDatabase(targetDatabaseId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取关系数据库');
    } finally {
      setLoading(false);
    }
  };
  const toggle = async (rowId: string) => {
    const next = selected.includes(rowId)
      ? selected.filter((candidate) => candidate !== rowId)
      : [...selected, rowId];
    try {
      await onSave(next);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存关系');
    }
  };
  return (
    <div className="database-relation-cell">
      <button type="button" disabled={disabled} onClick={() => void openPicker()}>
        {selected.length ? `${selected.length} 个关联页面` : '添加关联'}
      </button>
      {open ? (
        <div className="database-relation-picker">
          <header>
            <strong>{target?.database.title ?? '选择关联页面'}</strong>
            <button type="button" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {loading ? <p>正在加载…</p> : null}
          {error ? <p className="dialog-error">{error}</p> : null}
          {target?.rows.map((row) => (
            <label key={row.id}>
              <input
                type="checkbox"
                checked={selected.includes(row.id)}
                onChange={() => void toggle(row.id)}
              />
              <span>{rowTitle(row, target.properties)}</span>
            </label>
          ))}
          {target && !target.rows.length ? <p>目标数据库还没有记录。</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function PersonCell({
  organizationId,
  value,
  disabled,
  onSave,
}: {
  organizationId: string;
  value: JsonValue | undefined;
  disabled: boolean;
  onSave: (value: JsonValue) => Promise<void>;
}) {
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<OrganizationMemberSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openPicker = async () => {
    if (disabled) return;
    setOpen(true);
    if (members.length || loading) return;
    setLoading(true);
    try {
      const result = await listOrganizationMembers(organizationId);
      setMembers(result.members.filter((member) => member.status === 'active'));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取成员');
    } finally {
      setLoading(false);
    }
  };
  const toggle = async (userId: string) => {
    try {
      await onSave(
        selected.includes(userId)
          ? selected.filter((candidate) => candidate !== userId)
          : [...selected, userId],
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存人员');
    }
  };
  return (
    <div className="database-relation-cell">
      <button type="button" disabled={disabled} onClick={() => void openPicker()}>
        {selected.length ? `${selected.length} 位成员` : '选择成员'}
      </button>
      {open ? (
        <div className="database-relation-picker">
          <header>
            <strong>选择成员</strong>
            <button type="button" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {loading ? <p>正在加载…</p> : null}
          {error ? <p className="dialog-error">{error}</p> : null}
          {members.map((member) => (
            <label key={member.userId}>
              <input
                type="checkbox"
                checked={selected.includes(member.userId)}
                onChange={() => void toggle(member.userId)}
              />
              <span>{member.displayName}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FileCell({
  pageId,
  value,
  disabled,
  onSave,
}: {
  pageId: string;
  value: JsonValue | undefined;
  disabled: boolean;
  onSave: (value: JsonValue) => Promise<void>;
}) {
  const selected = Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
  const [open, setOpen] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const openPicker = async () => {
    if (disabled) return;
    setOpen(true);
    if (attachments.length) return;
    try {
      setAttachments((await listAttachments(pageId)).attachments);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取文件');
    }
  };
  const upload = async (file: File | undefined) => {
    if (!file || busy) return;
    setBusy(true);
    try {
      const { attachment } = await uploadAttachment(pageId, file);
      setAttachments((current) => [attachment, ...current]);
      await onSave([...selected, attachment.id]);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法上传文件');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const toggle = async (attachmentId: string) => {
    try {
      await onSave(
        selected.includes(attachmentId)
          ? selected.filter((candidate) => candidate !== attachmentId)
          : [...selected, attachmentId],
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存文件属性');
    }
  };
  return (
    <div className="database-relation-cell">
      <input
        ref={input}
        hidden
        type="file"
        onChange={(event) => void upload(event.target.files?.[0])}
      />
      <button type="button" disabled={disabled} onClick={() => void openPicker()}>
        {selected.length ? `${selected.length} 个文件` : '添加文件'}
      </button>
      {open ? (
        <div className="database-relation-picker database-file-picker">
          <header>
            <strong>文件与媒体</strong>
            <button type="button" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {error ? <p className="dialog-error">{error}</p> : null}
          <button
            type="button"
            className="database-upload-file"
            onClick={() => input.current?.click()}
          >
            <Plus size={13} /> {busy ? '上传中…' : '上传文件'}
          </button>
          {attachments.map((attachment) => (
            <label key={attachment.id}>
              <input
                type="checkbox"
                checked={selected.includes(attachment.id)}
                onChange={() => void toggle(attachment.id)}
              />
              <span>{attachment.originalName}</span>
            </label>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PlaceCell({
  value,
  disabled,
  onSave,
}: {
  value: JsonValue | undefined;
  disabled: boolean;
  onSave: (value: JsonValue) => Promise<void>;
}) {
  const current = value && !Array.isArray(value) && typeof value === 'object' ? value : {};
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(typeof current.name === 'string' ? current.name : '');
  const [address, setAddress] = useState(
    typeof current.address === 'string' ? current.address : '',
  );
  const [latitude, setLatitude] = useState(
    typeof current.latitude === 'number' ? String(current.latitude) : '',
  );
  const [longitude, setLongitude] = useState(
    typeof current.longitude === 'number' ? String(current.longitude) : '',
  );
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    try {
      await onSave({
        name,
        ...(address ? { address } : {}),
        latitude: Number(latitude),
        longitude: Number(longitude),
      });
      setError(null);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存地点');
    }
  };
  return (
    <div className="database-relation-cell">
      <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
        {typeof current.name === 'string' ? current.name : '添加地点'}
      </button>
      {open ? (
        <div className="database-relation-picker database-place-picker">
          <header>
            <strong>地点</strong>
            <button type="button" onClick={() => setOpen(false)}>
              ×
            </button>
          </header>
          {error ? <p className="dialog-error">{error}</p> : null}
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="地点名称"
          />
          <input
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="地址（可选）"
          />
          <div>
            <input
              value={latitude}
              onChange={(event) => setLatitude(event.target.value)}
              placeholder="纬度"
              inputMode="decimal"
            />
            <input
              value={longitude}
              onChange={(event) => setLongitude(event.target.value)}
              placeholder="经度"
              inputMode="decimal"
            />
          </div>
          <button
            type="button"
            className="database-upload-file"
            disabled={!name || !latitude || !longitude}
            onClick={() => void save()}
          >
            保存地点
          </button>
        </div>
      ) : null}
    </div>
  );
}

function DatabaseCell({
  property,
  value,
  disabled,
  onSave,
  openPage,
  organizationId,
  rowPageId,
}: {
  property: DatabasePropertySummary;
  value: JsonValue | undefined;
  disabled: boolean;
  onSave: (value: JsonValue) => Promise<void>;
  openPage?: string;
  organizationId?: string;
  rowPageId?: string;
}) {
  const [draft, setDraft] = useState(() => toInputValue(property, value));
  const [saving, setSaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const saved = useRef(toInputValue(property, value));

  useEffect(() => {
    const next = toInputValue(property, value);
    saved.current = next;
    setDraft(next);
  }, [property, value]);

  const flush = useCallback(
    async (next = draft) => {
      window.clearTimeout(timer.current);
      if (next === saved.current || disabled) return;
      setSaving(true);
      try {
        await onSave(fromInputValue(property, next));
        saved.current = next;
      } finally {
        setSaving(false);
      }
    },
    [disabled, draft, onSave, property],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  if (!EDITABLE_PROPERTY_TYPES.has(property.type)) {
    const text = valueText(value);
    return <span className={`database-computed-value ${text ? '' : 'empty'}`}>{text || '—'}</span>;
  }
  if (property.type === 'checkbox') {
    return (
      <label className="database-checkbox-cell">
        <input
          type="checkbox"
          checked={value === true}
          disabled={disabled || saving}
          onChange={(event) => void onSave(event.target.checked)}
        />
        <span>{value === true ? '完成' : ''}</span>
      </label>
    );
  }
  const options = optionNames(property);
  if ((property.type === 'select' || property.type === 'status') && options.length) {
    return (
      <select
        className="database-select-cell"
        value={draft}
        disabled={disabled || saving}
        onChange={(event) => {
          setDraft(event.target.value);
          void flush(event.target.value);
        }}
      >
        <option value="">—</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  if (property.type === 'relation') {
    return <RelationCell property={property} value={value} disabled={disabled} onSave={onSave} />;
  }
  if (property.type === 'person' && organizationId) {
    return (
      <PersonCell
        organizationId={organizationId}
        value={value}
        disabled={disabled}
        onSave={onSave}
      />
    );
  }
  if (property.type === 'files' && rowPageId) {
    return <FileCell pageId={rowPageId} value={value} disabled={disabled} onSave={onSave} />;
  }
  if (property.type === 'person' || property.type === 'files') {
    return <span className="database-reference-value">{valueText(value) || '—'}</span>;
  }
  if (property.type === 'place') {
    return <PlaceCell value={value} disabled={disabled} onSave={onSave} />;
  }
  const inputType =
    property.type === 'number' ? 'number' : property.type === 'date' ? 'date' : 'text';
  return (
    <div className={`database-input-cell ${saving ? 'saving' : ''}`}>
      <input
        type={inputType}
        value={draft}
        disabled={disabled}
        inputMode={property.type === 'number' ? 'decimal' : undefined}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void flush(next), 550);
        }}
        onBlur={() => void flush()}
        aria-label={property.name}
      />
      {property.type === 'title' && openPage ? (
        <a
          href={`/p/${encodeURIComponent(openPage)}`}
          aria-label="打开数据行页面"
          title="打开为页面"
        >
          <ExternalLink size={13} />
        </a>
      ) : null}
    </div>
  );
}

function EmptyDatabase({ onCreate, disabled }: { onCreate: () => void; disabled: boolean }) {
  return (
    <div className="database-empty">
      <Table2 size={28} />
      <strong>这个数据库还没有记录</strong>
      <p>添加第一行；每一行都可以打开成完整的协作文档。</p>
      {!disabled ? (
        <button type="button" onClick={onCreate}>
          <Plus size={15} /> 新建记录
        </button>
      ) : null}
    </div>
  );
}

function TableDatabaseView({
  organizationId,
  rows,
  properties,
  canEdit,
  saveCell,
  addRow,
  removeRow,
  openProperty,
  view,
  updateViewConfig,
}: DatabaseViewProps & { openProperty: (property: DatabasePropertySummary) => void }) {
  if (!rows.length) return <EmptyDatabase onCreate={addRow} disabled={!canEdit} />;
  const groupPropertyId =
    typeof view.config.groupPropertyId === 'string' ? view.config.groupPropertyId : null;
  const groups = groupDatabaseRows(rows, groupPropertyId);
  const collapsedGroups = new Set(
    Array.isArray(view.config.collapsedGroups)
      ? view.config.collapsedGroups.filter((value): value is string => typeof value === 'string')
      : [],
  );
  const propertyWidths =
    view.config.propertyWidths &&
    !Array.isArray(view.config.propertyWidths) &&
    typeof view.config.propertyWidths === 'object'
      ? view.config.propertyWidths
      : {};
  const aggregations =
    view.config.aggregations &&
    !Array.isArray(view.config.aggregations) &&
    typeof view.config.aggregations === 'object'
      ? view.config.aggregations
      : {};
  const grouped = Boolean(groupPropertyId);
  return (
    <div className="database-table-wrap">
      <table className="database-table">
        <thead>
          <tr>
            {properties.map((property) => (
              <th
                key={property.id}
                style={{
                  width:
                    typeof propertyWidths[property.id] === 'number'
                      ? Number(propertyWidths[property.id])
                      : undefined,
                }}
              >
                <button type="button" onClick={() => openProperty(property)}>
                  <span>{PROPERTY_LABELS[property.type]}</span>
                  {property.name}
                  <ChevronDown size={12} />
                </button>
              </th>
            ))}
            {canEdit ? <th className="database-row-actions-heading" /> : null}
          </tr>
        </thead>
        {groups.map((group) => (
          <Fragment key={group.key}>
            {grouped ? (
              <tbody className="database-table-group-heading">
                <tr>
                  <th colSpan={properties.length + (canEdit ? 1 : 0)}>
                    <button
                      type="button"
                      onClick={() => {
                        const next = new Set(collapsedGroups);
                        if (next.has(group.key)) next.delete(group.key);
                        else next.add(group.key);
                        void updateViewConfig({
                          ...view.config,
                          collapsedGroups: [...next],
                        });
                      }}
                    >
                      <ChevronDown className={collapsedGroups.has(group.key) ? 'collapsed' : ''} />
                      {group.label} <small>{group.rows.length}</small>
                    </button>
                  </th>
                </tr>
              </tbody>
            ) : null}
            {!collapsedGroups.has(group.key) ? (
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id}>
                    {properties.map((property) => (
                      <td key={property.id}>
                        <DatabaseCell
                          property={property}
                          value={row.values[property.id]}
                          disabled={!canEdit}
                          openPage={property.type === 'title' ? row.pageId : undefined}
                          organizationId={organizationId}
                          rowPageId={row.pageId}
                          onSave={(value) => saveCell(row, property, value)}
                        />
                      </td>
                    ))}
                    {canEdit ? (
                      <td className="database-row-actions">
                        <button
                          type="button"
                          title="归档记录"
                          aria-label={`归档${rowTitle(row, properties)}`}
                          onClick={() => removeRow(row)}
                        >
                          <Archive size={14} />
                        </button>
                      </td>
                    ) : null}
                  </tr>
                ))}
                {Object.keys(aggregations).length ? (
                  <tr className="database-table-aggregations">
                    {properties.map((property) => {
                      const aggregation = aggregations[property.id];
                      return (
                        <td key={property.id}>
                          {typeof aggregation === 'string'
                            ? databaseAggregationValue(
                                group.rows,
                                property.id,
                                aggregation as DatabaseAggregation,
                              )
                            : ''}
                        </td>
                      );
                    })}
                    {canEdit ? <td /> : null}
                  </tr>
                ) : null}
              </tbody>
            ) : null}
          </Fragment>
        ))}
      </table>
      {canEdit ? (
        <button className="database-new-row" type="button" onClick={addRow}>
          <Plus size={14} /> 新建
        </button>
      ) : null}
    </div>
  );
}

interface DatabaseViewProps {
  organizationId: string;
  rows: DatabaseRowSummary[];
  properties: DatabasePropertySummary[];
  view: DatabaseViewSummary;
  canEdit: boolean;
  saveCell: (
    row: DatabaseRowSummary,
    property: DatabasePropertySummary,
    value: JsonValue,
  ) => Promise<void>;
  addRow: () => void;
  createRow: (values: Record<string, JsonValue>) => Promise<boolean>;
  removeRow: (row: DatabaseRowSummary) => void;
  updateViewConfig: (config: Record<string, JsonValue>) => Promise<void>;
}

function PropertyPicker({
  label,
  value,
  properties,
  types,
  onChange,
}: {
  label: string;
  value: string;
  properties: DatabasePropertySummary[];
  types?: ReadonlySet<DatabasePropertyType>;
  onChange: (propertyId: string) => void;
}) {
  return (
    <label className="database-property-picker">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {properties
          .filter((property) => !types || types.has(property.type))
          .map((property) => (
            <option key={property.id} value={property.id}>
              {property.name}
            </option>
          ))}
      </select>
    </label>
  );
}

function BoardDatabaseView(props: DatabaseViewProps) {
  const groupCandidates = props.properties.filter((property) =>
    ['status', 'select', 'checkbox'].includes(property.type),
  );
  const groupProperty =
    props.properties.find((property) => property.id === props.view.config.groupPropertyId) ??
    groupCandidates[0];
  if (!groupProperty) {
    return (
      <ViewRequirement
        icon={<KanbanSquare size={24} />}
        text="添加状态、单选或复选框属性后即可分组看板。"
      />
    );
  }
  const groups = new Map<string, DatabaseRowSummary[]>();
  for (const row of props.rows) {
    const name = valueText(row.values[groupProperty.id]) || '未分组';
    groups.set(name, [...(groups.get(name) ?? []), row]);
  }
  for (const option of optionNames(groupProperty)) if (!groups.has(option)) groups.set(option, []);
  return (
    <div className="database-board-shell">
      <PropertyPicker
        label="分组"
        value={groupProperty.id}
        properties={groupCandidates}
        onChange={(groupPropertyId) =>
          void props.updateViewConfig({ ...props.view.config, groupPropertyId })
        }
      />
      <div className="database-board">
        {[...groups].map(([name, rows]) => (
          <section key={name}>
            <header>
              <span>{name}</span>
              <small>{rows.length}</small>
            </header>
            {rows.map((row) => (
              <article key={row.id}>
                <a href={`/p/${encodeURIComponent(row.pageId)}`}>
                  {rowTitle(row, props.properties)}
                </a>
                {props.properties
                  .filter((property) => property.id !== titleProperty(props.properties)?.id)
                  .slice(0, 3)
                  .map((property) => (
                    <div key={property.id}>
                      <small>{property.name}</small>
                      <DatabaseCell
                        property={property}
                        value={row.values[property.id]}
                        disabled={!props.canEdit}
                        organizationId={props.organizationId}
                        rowPageId={row.pageId}
                        onSave={(value) => props.saveCell(row, property, value)}
                      />
                    </div>
                  ))}
              </article>
            ))}
            {props.canEdit ? (
              <button type="button" onClick={props.addRow}>
                <Plus size={13} /> 新建
              </button>
            ) : null}
          </section>
        ))}
      </div>
    </div>
  );
}

const DATE_TYPES = new Set<DatabasePropertyType>(['date', 'created_time', 'last_edited_time']);

function CalendarDatabaseView(props: DatabaseViewProps) {
  const dateCandidates = props.properties.filter((property) => DATE_TYPES.has(property.type));
  const dateProperty =
    props.properties.find((property) => property.id === props.view.config.datePropertyId) ??
    dateCandidates[0];
  if (!dateProperty) {
    return (
      <ViewRequirement icon={<CalendarDays size={24} />} text="添加日期属性后即可使用日历。" />
    );
  }
  const datedRows = props.rows
    .map((row) => ({ row, date: dateInputValue(row.values[dateProperty.id]) }))
    .filter((item) => item.date)
    .sort((left, right) => left.date.localeCompare(right.date));
  return (
    <div className="database-calendar-shell">
      <PropertyPicker
        label="日期"
        value={dateProperty.id}
        properties={dateCandidates}
        onChange={(datePropertyId) =>
          void props.updateViewConfig({ ...props.view.config, datePropertyId })
        }
      />
      <div className="database-calendar-list">
        {datedRows.length ? (
          datedRows.map(({ row, date }) => (
            <article key={row.id}>
              <time>
                {new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  weekday: 'short',
                })}
              </time>
              <a href={`/p/${encodeURIComponent(row.pageId)}`}>{rowTitle(row, props.properties)}</a>
            </article>
          ))
        ) : (
          <ViewRequirement icon={<CalendarDays size={24} />} text="还没有设置日期的记录。" />
        )}
      </div>
    </div>
  );
}

function ListDatabaseView(props: DatabaseViewProps) {
  if (!props.rows.length)
    return <EmptyDatabase onCreate={props.addRow} disabled={!props.canEdit} />;
  return (
    <div className="database-list-view">
      {props.rows.map((row) => (
        <a key={row.id} href={`/p/${encodeURIComponent(row.pageId)}`}>
          <FileText size={17} />
          <strong>{rowTitle(row, props.properties)}</strong>
          {props.properties.slice(1, 4).map((property) => (
            <span key={property.id}>{valueText(row.values[property.id]) || '—'}</span>
          ))}
          <ExternalLink size={14} />
        </a>
      ))}
    </div>
  );
}

function GalleryDatabaseView(props: DatabaseViewProps) {
  if (!props.rows.length)
    return <EmptyDatabase onCreate={props.addRow} disabled={!props.canEdit} />;
  return (
    <div className="database-gallery-view">
      {props.rows.map((row) => (
        <article key={row.id}>
          <div className="database-gallery-cover">
            {rowTitle(row, props.properties).slice(0, 1)}
          </div>
          <a href={`/p/${encodeURIComponent(row.pageId)}`}>{rowTitle(row, props.properties)}</a>
          {props.properties.slice(1, 4).map((property) => (
            <p key={property.id}>
              <small>{property.name}</small> {valueText(row.values[property.id]) || '—'}
            </p>
          ))}
        </article>
      ))}
    </div>
  );
}

function TimelineDatabaseView(props: DatabaseViewProps) {
  const dateCandidates = props.properties.filter((property) => DATE_TYPES.has(property.type));
  const dateProperty =
    props.properties.find((property) => property.id === props.view.config.datePropertyId) ??
    dateCandidates[0];
  if (!dateProperty)
    return <ViewRequirement icon={<Columns3 size={24} />} text="添加日期属性后即可使用时间线。" />;
  const rows = props.rows
    .map((row) => ({ row, date: dateInputValue(row.values[dateProperty.id]) }))
    .filter((item) => item.date)
    .sort((left, right) => left.date.localeCompare(right.date));
  return (
    <div className="database-timeline-view">
      <PropertyPicker
        label="时间"
        value={dateProperty.id}
        properties={dateCandidates}
        onChange={(datePropertyId) =>
          void props.updateViewConfig({ ...props.view.config, datePropertyId })
        }
      />
      {rows.map(({ row, date }, index) => (
        <article key={row.id} style={{ '--timeline-offset': index % 4 } as React.CSSProperties}>
          <time>{date}</time>
          <a href={`/p/${encodeURIComponent(row.pageId)}`}>{rowTitle(row, props.properties)}</a>
        </article>
      ))}
    </div>
  );
}

function ChartDatabaseView(props: DatabaseViewProps) {
  const candidates = props.properties.filter((property) =>
    ['select', 'status', 'checkbox', 'person'].includes(property.type),
  );
  const groupProperty =
    props.properties.find((property) => property.id === props.view.config.groupPropertyId) ??
    candidates[0];
  if (!groupProperty)
    return (
      <ViewRequirement icon={<BarChart3 size={24} />} text="添加状态或选项属性后即可创建图表。" />
    );
  const counts = new Map<string, number>();
  for (const row of props.rows) {
    const key = valueText(row.values[groupProperty.id]) || '空';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const maximum = Math.max(1, ...counts.values());
  return (
    <div className="database-chart-view">
      <PropertyPicker
        label="分组"
        value={groupProperty.id}
        properties={candidates}
        onChange={(groupPropertyId) =>
          void props.updateViewConfig({ ...props.view.config, groupPropertyId })
        }
      />
      <div className="database-bars">
        {[...counts].map(([label, count]) => (
          <div key={label}>
            <span>{label}</span>
            <i style={{ '--bar-size': count / maximum } as React.CSSProperties} />
            <strong>{count}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

function FormDatabaseView(props: DatabaseViewProps) {
  const editable = props.properties.filter((property) => FORM_PROPERTY_TYPES.has(property.type));
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !props.canEdit) return;
    setBusy(true);
    try {
      if (!(await props.createRow(values))) return;
      setValues({});
      setSubmitted(true);
      window.setTimeout(() => setSubmitted(false), 2_000);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="database-form-view" onSubmit={(event) => void submit(event)}>
      <header>
        <ListPlus size={22} />
        <div>
          <h3>{props.view.name}</h3>
          <p>提交内容会成为数据库中的一条记录。</p>
        </div>
      </header>
      {editable.map((property) => (
        <label key={property.id}>
          <span>{property.name}</span>
          {property.type === 'checkbox' ? (
            <input
              type="checkbox"
              checked={values[property.id] === true}
              onChange={(event) =>
                setValues((current) => ({ ...current, [property.id]: event.target.checked }))
              }
            />
          ) : (
            <input
              type={
                property.type === 'number' ? 'number' : property.type === 'date' ? 'date' : 'text'
              }
              value={toInputValue(property, values[property.id])}
              onChange={(event) =>
                setValues((current) => ({
                  ...current,
                  [property.id]: fromInputValue(property, event.target.value),
                }))
              }
            />
          )}
        </label>
      ))}
      <button type="submit" disabled={!props.canEdit || busy}>
        {submitted ? <Check size={15} /> : null}
        {submitted ? '已提交' : busy ? '提交中…' : '提交'}
      </button>
    </form>
  );
}

function FeedDatabaseView(props: DatabaseViewProps) {
  return (
    <div className="database-feed-view">
      {props.rows
        .slice()
        .sort((left, right) => right.updatedAt - left.updatedAt)
        .map((row) => (
          <article key={row.id}>
            <span>{rowTitle(row, props.properties).slice(0, 1)}</span>
            <div>
              <a href={`/p/${encodeURIComponent(row.pageId)}`}>{rowTitle(row, props.properties)}</a>
              <p>
                {props.properties
                  .slice(1, 3)
                  .map((property) => valueText(row.values[property.id]))
                  .filter(Boolean)
                  .join(' · ') || '暂无摘要'}
              </p>
              <time>{new Date(row.updatedAt).toLocaleString()}</time>
            </div>
          </article>
        ))}
    </div>
  );
}

function MapDatabaseView(props: DatabaseViewProps) {
  const places = props.properties.filter((property) => property.type === 'place');
  const placeProperty =
    props.properties.find((property) => property.id === props.view.config.placePropertyId) ??
    places[0];
  if (!placeProperty)
    return (
      <ViewRequirement icon={<MapPinned size={24} />} text="添加地点属性后即可使用地图视图。" />
    );
  return (
    <div className="database-map-view">
      <PropertyPicker
        label="地点"
        value={placeProperty.id}
        properties={places}
        onChange={(placePropertyId) =>
          void props.updateViewConfig({ ...props.view.config, placePropertyId })
        }
      />
      <div className="database-map-canvas">
        <MapPinned size={34} />
        <p>地点数据视图</p>
      </div>
      {props.rows
        .filter((row) => row.values[placeProperty.id])
        .map((row) => (
          <a key={row.id} href={`/p/${encodeURIComponent(row.pageId)}`}>
            <MapPinned size={14} /> {rowTitle(row, props.properties)}
            <span>{valueText(row.values[placeProperty.id])}</span>
          </a>
        ))}
    </div>
  );
}

function DashboardDatabaseView(props: DatabaseViewProps) {
  return (
    <div className="database-dashboard-view">
      <section>
        <h3>总记录</h3>
        <strong>{props.rows.length}</strong>
      </section>
      <section className="wide">
        <h3>数据概览</h3>
        <ChartDatabaseView {...props} />
      </section>
      <section className="wide">
        <h3>最近更新</h3>
        <FeedDatabaseView {...props} />
      </section>
    </div>
  );
}

function ViewRequirement({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="database-view-requirement">
      {icon}
      <p>{text}</p>
    </div>
  );
}

function renderView(
  props: DatabaseViewProps,
  openProperty: (property: DatabasePropertySummary) => void,
) {
  switch (props.view.type) {
    case 'table':
      return <TableDatabaseView {...props} openProperty={openProperty} />;
    case 'board':
      return <BoardDatabaseView {...props} />;
    case 'calendar':
      return <CalendarDatabaseView {...props} />;
    case 'list':
      return <ListDatabaseView {...props} />;
    case 'gallery':
      return <GalleryDatabaseView {...props} />;
    case 'timeline':
      return <TimelineDatabaseView {...props} />;
    case 'chart':
      return <ChartDatabaseView {...props} />;
    case 'dashboard':
      return <DashboardDatabaseView {...props} />;
    case 'form':
      return <FormDatabaseView {...props} />;
    case 'feed':
      return <FeedDatabaseView {...props} />;
    case 'map':
      return <MapDatabaseView {...props} />;
  }
}

function ViewOptionsPanel({
  view,
  properties,
  canEdit,
  canLock,
  locked,
  canDelete,
  onUpdate,
  onToggleLock,
  onDelete,
}: {
  view: DatabaseViewSummary;
  properties: DatabasePropertySummary[];
  canEdit: boolean;
  canLock: boolean;
  locked: boolean;
  canDelete: boolean;
  onUpdate: (config: Record<string, JsonValue>) => Promise<void>;
  onToggleLock: () => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [filterPropertyId, setFilterPropertyId] = useState(properties[0]?.id ?? '');
  const [filterOperator, setFilterOperator] = useState<DatabaseFilterOperator>('equals');
  const [filterValue, setFilterValue] = useState('');
  const [sortPropertyId, setSortPropertyId] = useState(properties[0]?.id ?? '');
  const [sortDirection, setSortDirection] = useState<'ascending' | 'descending'>('ascending');
  const filters = databaseViewFilters(view.config);
  const sorts = databaseViewSorts(view.config);
  const propertyNames = new Map(properties.map((property) => [property.id, property.name]));
  const visiblePropertyIds = new Set(
    Array.isArray(view.config.visiblePropertyIds)
      ? view.config.visiblePropertyIds.filter((id): id is string => typeof id === 'string')
      : properties.map((property) => property.id),
  );
  const configuredOrder = Array.isArray(view.config.propertyOrder)
    ? view.config.propertyOrder.filter((id): id is string => typeof id === 'string')
    : [];
  const propertyOrder = [
    ...configuredOrder.filter((id) => propertyNames.has(id)),
    ...properties.map((property) => property.id).filter((id) => !configuredOrder.includes(id)),
  ];
  const propertyWidths =
    view.config.propertyWidths &&
    !Array.isArray(view.config.propertyWidths) &&
    typeof view.config.propertyWidths === 'object'
      ? view.config.propertyWidths
      : {};
  const aggregations =
    view.config.aggregations &&
    !Array.isArray(view.config.aggregations) &&
    typeof view.config.aggregations === 'object'
      ? view.config.aggregations
      : {};
  const addFilter = async () => {
    if (!filterPropertyId) return;
    const next = [
      ...filters,
      {
        propertyId: filterPropertyId,
        operator: filterOperator,
        value:
          filterOperator === 'is_empty' || filterOperator === 'is_not_empty' ? null : filterValue,
      },
    ];
    await onUpdate({
      ...view.config,
      filters: next.map(({ propertyId, operator, value }) => ({ propertyId, operator, value })),
    });
    setFilterValue('');
  };
  const addSort = async () => {
    if (!sortPropertyId) return;
    const next = [
      ...sorts.filter((sort) => sort.propertyId !== sortPropertyId),
      { propertyId: sortPropertyId, direction: sortDirection },
    ];
    await onUpdate({
      ...view.config,
      sorts: next.map(({ propertyId, direction }) => ({ propertyId, direction })),
    });
  };
  return (
    <div className="database-view-options">
      <section>
        <header>
          <strong>筛选</strong>
          <select
            value={view.config.filterMode === 'or' ? 'or' : 'and'}
            disabled={!canEdit}
            onChange={(event) =>
              void onUpdate({ ...view.config, filterMode: event.target.value as 'and' | 'or' })
            }
          >
            <option value="and">满足全部</option>
            <option value="or">满足任一</option>
          </select>
        </header>
        {filters.map((filter, index) => (
          <div className="database-view-rule" key={`${filter.propertyId}:${index}`}>
            <span>{propertyNames.get(filter.propertyId) ?? '已删除属性'}</span>
            <small>{filter.operator}</small>
            <b>{valueText(filter.value) || '空'}</b>
            {canEdit ? (
              <button
                type="button"
                aria-label="删除筛选"
                onClick={() =>
                  void onUpdate({
                    ...view.config,
                    filters: filters
                      .filter((_, candidateIndex) => candidateIndex !== index)
                      .map(({ propertyId, operator, value }) => ({
                        propertyId,
                        operator,
                        value,
                      })),
                  })
                }
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <div className="database-rule-builder">
            <select
              value={filterPropertyId}
              onChange={(event) => setFilterPropertyId(event.target.value)}
            >
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
            <select
              value={filterOperator}
              onChange={(event) => setFilterOperator(event.target.value as DatabaseFilterOperator)}
            >
              <option value="equals">等于</option>
              <option value="not_equals">不等于</option>
              <option value="contains">包含</option>
              <option value="not_contains">不包含</option>
              <option value="greater_than">大于</option>
              <option value="less_than">小于</option>
              <option value="on_or_before">不晚于</option>
              <option value="on_or_after">不早于</option>
              <option value="is_empty">为空</option>
              <option value="is_not_empty">不为空</option>
            </select>
            {filterOperator !== 'is_empty' && filterOperator !== 'is_not_empty' ? (
              <input
                value={filterValue}
                onChange={(event) => setFilterValue(event.target.value)}
                placeholder="值"
              />
            ) : null}
            <button type="button" onClick={() => void addFilter()}>
              <Plus size={13} />
            </button>
          </div>
        ) : null}
      </section>
      <section>
        <header>
          <strong>排序</strong>
        </header>
        {sorts.map((sort, index) => (
          <div className="database-view-rule" key={`${sort.propertyId}:${index}`}>
            <span>{propertyNames.get(sort.propertyId) ?? '已删除属性'}</span>
            <b>{sort.direction === 'ascending' ? '升序' : '降序'}</b>
            {canEdit ? (
              <button
                type="button"
                aria-label="删除排序"
                onClick={() =>
                  void onUpdate({
                    ...view.config,
                    sorts: sorts
                      .filter((_, candidateIndex) => candidateIndex !== index)
                      .map(({ propertyId, direction }) => ({ propertyId, direction })),
                  })
                }
              >
                ×
              </button>
            ) : null}
          </div>
        ))}
        {canEdit ? (
          <div className="database-rule-builder">
            <select
              value={sortPropertyId}
              onChange={(event) => setSortPropertyId(event.target.value)}
            >
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
            <select
              value={sortDirection}
              onChange={(event) =>
                setSortDirection(event.target.value as 'ascending' | 'descending')
              }
            >
              <option value="ascending">升序</option>
              <option value="descending">降序</option>
            </select>
            <button type="button" onClick={() => void addSort()}>
              <Plus size={13} />
            </button>
          </div>
        ) : null}
      </section>
      <section>
        <header>
          <strong>分组</strong>
        </header>
        <label className="database-view-config-field">
          <span>按属性分组</span>
          <select
            value={
              typeof view.config.groupPropertyId === 'string' ? view.config.groupPropertyId : ''
            }
            disabled={!canEdit}
            onChange={(event) =>
              void onUpdate({
                ...view.config,
                groupPropertyId: event.target.value || null,
                collapsedGroups: [],
              })
            }
          >
            <option value="">不分组</option>
            {properties.map((property) => (
              <option key={property.id} value={property.id}>
                {property.name}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section>
        <header>
          <strong>属性、列宽与计算</strong>
        </header>
        <div className="database-view-properties">
          {propertyOrder.map((propertyId, index) => {
            const property = properties.find((candidate) => candidate.id === propertyId);
            if (!property) return null;
            const aggregation = aggregations[property.id];
            return (
              <div key={property.id} className="database-view-property-row">
                <label>
                  <input
                    type="checkbox"
                    checked={property.type === 'title' || visiblePropertyIds.has(property.id)}
                    disabled={!canEdit || property.type === 'title'}
                    onChange={(event) => {
                      const next = new Set(visiblePropertyIds);
                      if (event.target.checked) next.add(property.id);
                      else next.delete(property.id);
                      void onUpdate({ ...view.config, visiblePropertyIds: [...next] });
                    }}
                  />
                  <span>{property.name}</span>
                </label>
                <div className="database-view-property-order">
                  <button
                    type="button"
                    aria-label={`${property.name}前移`}
                    disabled={!canEdit || index === 0}
                    onClick={() => {
                      const next = [...propertyOrder];
                      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
                      void onUpdate({ ...view.config, propertyOrder: next });
                    }}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label={`${property.name}后移`}
                    disabled={!canEdit || index === propertyOrder.length - 1}
                    onClick={() => {
                      const next = [...propertyOrder];
                      [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
                      void onUpdate({ ...view.config, propertyOrder: next });
                    }}
                  >
                    ↓
                  </button>
                </div>
                <input
                  className="database-view-width"
                  type="number"
                  min={100}
                  max={600}
                  step={20}
                  aria-label={`${property.name}列宽`}
                  disabled={!canEdit}
                  value={
                    typeof propertyWidths[property.id] === 'number'
                      ? Number(propertyWidths[property.id])
                      : 180
                  }
                  onChange={(event) =>
                    void onUpdate({
                      ...view.config,
                      propertyWidths: {
                        ...propertyWidths,
                        [property.id]: Math.max(100, Math.min(600, Number(event.target.value))),
                      },
                    })
                  }
                />
                <select
                  aria-label={`${property.name}计算`}
                  disabled={!canEdit}
                  value={typeof aggregation === 'string' ? aggregation : ''}
                  onChange={(event) => {
                    const next = { ...aggregations };
                    if (event.target.value) next[property.id] = event.target.value;
                    else delete next[property.id];
                    void onUpdate({ ...view.config, aggregations: next });
                  }}
                >
                  <option value="">不计算</option>
                  <option value="count_all">全部计数</option>
                  <option value="count_values">非空计数</option>
                  <option value="count_unique">唯一值计数</option>
                  <option value="sum">求和</option>
                  <option value="average">平均值</option>
                  <option value="min">最小值</option>
                  <option value="max">最大值</option>
                  {property.type === 'checkbox' ? (
                    <option value="percent_checked">已选百分比</option>
                  ) : null}
                </select>
              </div>
            );
          })}
        </div>
      </section>
      <footer>
        {canLock ? (
          <button type="button" onClick={() => void onToggleLock()}>
            <Lock size={14} /> {locked ? '解锁数据库' : '锁定数据库'}
          </button>
        ) : null}
        {canDelete ? (
          <button className="danger" type="button" onClick={() => void onDelete()}>
            <Trash2 size={14} /> 删除当前视图
          </button>
        ) : null}
      </footer>
    </div>
  );
}

function PropertyDialog({
  databaseId,
  organizationId,
  properties,
  property,
  onClose,
  onChanged,
}: {
  databaseId: string;
  organizationId: string;
  properties: DatabasePropertySummary[];
  property?: DatabasePropertySummary;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState(property?.name ?? '新属性');
  const [type, setType] = useState<DatabasePropertyType>(property?.type ?? 'text');
  const [options, setOptions] = useState(() =>
    optionNames(property ?? ({ config: {} } as DatabasePropertySummary)).join(', '),
  );
  const [expression, setExpression] = useState(
    typeof property?.config.expression === 'string' ? property.config.expression : '',
  );
  const [targetDatabaseId, setTargetDatabaseId] = useState(
    typeof property?.config.targetDatabaseId === 'string' ? property.config.targetDatabaseId : '',
  );
  const [twoWayRelation, setTwoWayRelation] = useState(false);
  const [reciprocalName, setReciprocalName] = useState('关联页面');
  const [prefix, setPrefix] = useState(
    typeof property?.config.prefix === 'string' ? property.config.prefix : '',
  );
  const [relationPropertyId, setRelationPropertyId] = useState(
    typeof property?.config.relationPropertyId === 'string'
      ? property.config.relationPropertyId
      : '',
  );
  const [targetPropertyId, setTargetPropertyId] = useState(
    typeof property?.config.targetPropertyId === 'string' ? property.config.targetPropertyId : '',
  );
  const [calculation, setCalculation] = useState(
    typeof property?.config.calculation === 'string' ? property.config.calculation : 'count_all',
  );
  const [databases, setDatabases] = useState<DatabaseSnapshot['database'][]>([]);
  const [targetSnapshot, setTargetSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relationProperties = useMemo(
    () => properties.filter((candidate) => candidate.type === 'relation'),
    [properties],
  );

  useEffect(() => {
    let active = true;
    listOrganizationDatabases(organizationId)
      .then((result) => {
        if (active) setDatabases(result.databases);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [organizationId]);

  useEffect(() => {
    if (type !== 'rollup' || !relationPropertyId) return;
    const relation = relationProperties.find((candidate) => candidate.id === relationPropertyId);
    const targetId =
      typeof relation?.config.targetDatabaseId === 'string'
        ? relation.config.targetDatabaseId
        : targetDatabaseId;
    if (!targetId) return;
    setTargetDatabaseId(targetId);
    let active = true;
    getDatabase(targetId)
      .then((snapshot) => {
        if (active) setTargetSnapshot(snapshot);
      })
      .catch(() => active && setTargetSnapshot(null));
    return () => {
      active = false;
    };
  }, [relationProperties, relationPropertyId, targetDatabaseId, type]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const config: Record<string, JsonValue> = { ...(property?.config ?? {}) };
    if (type === 'select' || type === 'status' || type === 'multi_select') {
      config.options = options
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
    if (type === 'formula') config.expression = expression;
    if (type === 'relation') {
      config.targetDatabaseId = targetDatabaseId;
      if (!property && twoWayRelation) config.reciprocalName = reciprocalName;
    }
    if (type === 'rollup') {
      config.relationPropertyId = relationPropertyId;
      config.targetDatabaseId = targetDatabaseId;
      config.targetPropertyId = targetPropertyId;
      config.calculation = calculation;
    }
    if (type === 'unique_id') config.prefix = prefix;
    try {
      if (property) await updateDatabaseProperty(databaseId, property.id, { name, config });
      else await createDatabaseProperty(databaseId, { name, type, config });
      await onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存属性');
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (
      !property ||
      property.type === 'title' ||
      !window.confirm(`删除属性“${property.name}”及其数据？`)
    )
      return;
    setBusy(true);
    try {
      await deleteDatabaseProperty(databaseId, property.id);
      await onChanged();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除属性');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="rdocs-dialog database-dialog" onSubmit={(event) => void submit(event)}>
        <h2>{property ? '编辑属性' : '新建属性'}</h2>
        <label>
          名称
          <input
            value={name}
            maxLength={100}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
        </label>
        <label>
          类型
          <select
            value={type}
            disabled={Boolean(property)}
            onChange={(event) => setType(event.target.value as DatabasePropertyType)}
          >
            {Object.entries(PROPERTY_LABELS)
              .filter(([propertyType]) => propertyType !== 'title')
              .map(([propertyType, label]) => (
                <option key={propertyType} value={propertyType}>
                  {label}
                </option>
              ))}
          </select>
        </label>
        {type === 'select' || type === 'status' || type === 'multi_select' ? (
          <label>
            选项（逗号分隔）
            <input
              value={options}
              onChange={(event) => setOptions(event.target.value)}
              placeholder="未开始, 进行中, 已完成"
            />
          </label>
        ) : null}
        {type === 'formula' ? (
          <label>
            公式
            <textarea
              value={expression}
              onChange={(event) => setExpression(event.target.value)}
              placeholder={'if(prop("完成"), "✓", "")'}
            />
          </label>
        ) : null}
        {type === 'relation' ? (
          <>
            <label>
              目标数据库
              <select
                value={targetDatabaseId}
                disabled={Boolean(property)}
                onChange={(event) => setTargetDatabaseId(event.target.value)}
              >
                <option value="">选择数据库</option>
                {databases.map((database) => (
                  <option key={database.id} value={database.id}>
                    {database.title}
                  </option>
                ))}
              </select>
            </label>
            {property ? (
              typeof property.config.syncedPropertyId === 'string' ? (
                <p className="database-dialog-hint">此关系会自动同步到目标数据库。</p>
              ) : (
                <p className="database-dialog-hint">这是单向关系；如需双向关系，请新建属性。</p>
              )
            ) : (
              <>
                <label className="database-dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={twoWayRelation}
                    onChange={(event) => setTwoWayRelation(event.target.checked)}
                  />
                  在目标数据库中显示反向关系
                </label>
                {twoWayRelation ? (
                  <label>
                    反向属性名称
                    <input
                      value={reciprocalName}
                      maxLength={100}
                      onChange={(event) => setReciprocalName(event.target.value)}
                    />
                  </label>
                ) : null}
              </>
            )}
          </>
        ) : null}
        {type === 'rollup' ? (
          <>
            <label>
              关系属性
              <select
                value={relationPropertyId}
                onChange={(event) => setRelationPropertyId(event.target.value)}
              >
                <option value="">选择关系</option>
                {relationProperties.map((relation) => (
                  <option key={relation.id} value={relation.id}>
                    {relation.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              目标属性
              <select
                value={targetPropertyId}
                onChange={(event) => setTargetPropertyId(event.target.value)}
              >
                <option value="">选择属性</option>
                {targetSnapshot?.properties.map((targetProperty) => (
                  <option key={targetProperty.id} value={targetProperty.id}>
                    {targetProperty.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              计算方式
              <select value={calculation} onChange={(event) => setCalculation(event.target.value)}>
                <option value="show_original">显示原值</option>
                <option value="show_unique">显示唯一值</option>
                <option value="count_all">全部计数</option>
                <option value="count_values">非空计数</option>
                <option value="count_unique">唯一值计数</option>
                <option value="percent_empty">空值百分比</option>
                <option value="percent_not_empty">非空百分比</option>
                <option value="sum">求和</option>
                <option value="average">平均值</option>
                <option value="min">最小值</option>
                <option value="max">最大值</option>
                <option value="earliest_date">最早日期</option>
                <option value="latest_date">最晚日期</option>
              </select>
            </label>
          </>
        ) : null}
        {type === 'unique_id' ? (
          <label>
            ID 前缀
            <input
              value={prefix}
              onChange={(event) => setPrefix(event.target.value)}
              placeholder="TASK-"
            />
          </label>
        ) : null}
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions database-dialog-actions">
          {property && property.type !== 'title' ? (
            <button className="danger" type="button" disabled={busy} onClick={() => void remove()}>
              <Trash2 size={14} /> 删除
            </button>
          ) : null}
          <span />
          <button type="button" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </form>
    </div>
  );
}

function ViewDialog({
  databaseId,
  onClose,
  onCreated,
}: {
  databaseId: string;
  onClose: () => void;
  onCreated: (view: DatabaseViewSummary) => Promise<void>;
}) {
  const [name, setName] = useState('新视图');
  const [type, setType] = useState<DatabaseViewType>('table');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { view } = await createDatabaseView(databaseId, { name, type });
      await onCreated(view);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建视图');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <form className="rdocs-dialog database-dialog" onSubmit={(event) => void submit(event)}>
        <h2>新建视图</h2>
        <label>
          视图名称
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoFocus
            maxLength={100}
          />
        </label>
        <div className="database-view-type-grid">
          {Object.entries(VIEW_META).map(([viewType, meta]) => {
            const Icon = meta.icon;
            return (
              <button
                className={type === viewType ? 'active' : ''}
                type="button"
                key={viewType}
                onClick={() => {
                  setType(viewType as DatabaseViewType);
                  if (name === '新视图') setName(meta.label);
                }}
              >
                <Icon size={18} /> {meta.label}
              </button>
            );
          })}
        </div>
        {error ? <p className="dialog-error">{error}</p> : null}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? '创建中…' : '创建视图'}
          </button>
        </div>
      </form>
    </div>
  );
}

export function DatabaseCanvas({
  initialSnapshot,
  canEdit,
}: {
  initialSnapshot: DatabaseSnapshot;
  canEdit: boolean;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [activeViewId, setActiveViewId] = useState(initialSnapshot.views[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [propertyDialog, setPropertyDialog] = useState<DatabasePropertySummary | 'new' | null>(
    null,
  );
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const viewSaveQueue = useRef(new Map<string, Promise<void>>());
  const viewSaveVersion = useRef(new Map<string, number>());
  const activeView = snapshot.views.find((view) => view.id === activeViewId) ?? snapshot.views[0];
  const editable = canEdit && !snapshot.database.isLocked;
  const viewProperties = useMemo(
    () => orderedVisibleDatabaseProperties(snapshot.properties, activeView?.config ?? {}),
    [activeView?.config, snapshot.properties],
  );

  const refresh = useCallback(async () => {
    const next = await getDatabase(snapshot.database.id);
    setSnapshot(next);
  }, [snapshot.database.id]);

  const filteredRows = useMemo(() => {
    const viewed = applyDatabaseView(snapshot.rows, snapshot.properties, activeView?.config ?? {});
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return viewed;
    return viewed.filter((row) =>
      snapshot.properties.some((property) =>
        valueText(row.values[property.id]).toLocaleLowerCase().includes(normalized),
      ),
    );
  }, [activeView?.config, query, snapshot.properties, snapshot.rows]);

  const createRow = async (values: Record<string, JsonValue>) => {
    if (!editable || busy) return false;
    setBusy(true);
    setError(null);
    try {
      const { row } = await createDatabaseRow(snapshot.database.id, values);
      if (row) setSnapshot((current) => ({ ...current, rows: [...current.rows, row] }));
      return Boolean(row);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法新建记录');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const addRow = async () => {
    const title = titleProperty(snapshot.properties);
    await createRow(title ? { [title.id]: '未命名' } : {});
  };

  const saveCell = useCallback(
    async (row: DatabaseRowSummary, property: DatabasePropertySummary, value: JsonValue) => {
      const previous = row.values[property.id];
      setSnapshot((current) => ({
        ...current,
        rows: current.rows.map((candidate) =>
          candidate.id === row.id
            ? { ...candidate, values: { ...candidate.values, [property.id]: value } }
            : candidate,
        ),
      }));
      try {
        const result = await updateDatabaseRow(snapshot.database.id, row.id, {
          values: { [property.id]: value },
        });
        if (result.row) {
          setSnapshot((current) => ({
            ...current,
            rows: current.rows.map((candidate) =>
              candidate.id === row.id ? result.row! : candidate,
            ),
          }));
        }
        setError(null);
      } catch (reason) {
        setSnapshot((current) => ({
          ...current,
          rows: current.rows.map((candidate) =>
            candidate.id === row.id
              ? { ...candidate, values: { ...candidate.values, [property.id]: previous ?? null } }
              : candidate,
          ),
        }));
        setError(reason instanceof Error ? reason.message : '自动保存失败');
        throw reason;
      }
    },
    [snapshot.database.id],
  );

  const removeRow = async (row: DatabaseRowSummary) => {
    if (!editable || !window.confirm(`归档“${rowTitle(row, snapshot.properties)}”？`)) return;
    try {
      await deleteDatabaseRow(snapshot.database.id, row.id);
      setSnapshot((current) => ({
        ...current,
        rows: current.rows.filter((candidate) => candidate.id !== row.id),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法归档记录');
    }
  };

  const updateViewConfig = async (config: Record<string, JsonValue>) => {
    if (!activeView || !editable) return;
    const databaseId = snapshot.database.id;
    const viewId = activeView.id;
    const version = (viewSaveVersion.current.get(viewId) ?? 0) + 1;
    viewSaveVersion.current.set(viewId, version);
    setSnapshot((current) => ({
      ...current,
      views: current.views.map((candidate) =>
        candidate.id === viewId ? { ...candidate, config } : candidate,
      ),
    }));
    const preceding = viewSaveQueue.current.get(viewId) ?? Promise.resolve();
    const save = preceding
      .catch(() => undefined)
      .then(async () => {
        const { view } = await updateDatabaseView(databaseId, viewId, { config });
        if (viewSaveVersion.current.get(viewId) !== version) return;
        setSnapshot((current) => ({
          ...current,
          views: current.views.map((candidate) => (candidate.id === view.id ? view : candidate)),
        }));
        setError(null);
      })
      .catch(async (reason: unknown) => {
        if (viewSaveVersion.current.get(viewId) !== version) return;
        setError(reason instanceof Error ? reason.message : '视图自动保存失败');
        try {
          setSnapshot(await getDatabase(databaseId));
        } catch {
          // Keep the optimistic view visible while the connection recovers.
        }
      });
    viewSaveQueue.current.set(viewId, save);
    await save;
    if (viewSaveQueue.current.get(viewId) === save) viewSaveQueue.current.delete(viewId);
  };

  const removeActiveView = async () => {
    if (!activeView || !editable || !window.confirm(`删除视图“${activeView.name}”？`)) return;
    try {
      await deleteDatabaseView(snapshot.database.id, activeView.id);
      const remaining = snapshot.views.filter((view) => view.id !== activeView.id);
      setSnapshot((current) => ({ ...current, views: remaining }));
      setActiveViewId(remaining[0]?.id ?? '');
      setViewMenuOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除视图');
    }
  };

  const toggleLock = async () => {
    try {
      const { database } = await updateDatabase(snapshot.database.id, {
        isLocked: !snapshot.database.isLocked,
      });
      setSnapshot((current) => ({ ...current, database }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更改数据库锁定状态');
    }
  };

  if (!activeView)
    return <ViewRequirement icon={<Table2 size={24} />} text="数据库没有可用视图。" />;
  const viewProps: DatabaseViewProps = {
    organizationId: snapshot.database.organizationId,
    rows: filteredRows,
    properties: viewProperties,
    view: activeView,
    canEdit: editable,
    saveCell,
    addRow: () => void addRow(),
    createRow,
    removeRow: (row) => void removeRow(row),
    updateViewConfig,
  };

  return (
    <section className="database-canvas">
      <div className="database-tabs-row">
        <div className="database-tabs" role="tablist" aria-label="数据库视图">
          {snapshot.views.map((view) => {
            const meta = VIEW_META[view.type];
            const Icon = meta.icon;
            return (
              <button
                key={view.id}
                className={view.id === activeView.id ? 'active' : ''}
                type="button"
                role="tab"
                aria-selected={view.id === activeView.id}
                onClick={() => setActiveViewId(view.id)}
              >
                <Icon size={14} /> {view.name}
              </button>
            );
          })}
          {editable ? (
            <button
              type="button"
              className="database-add-view"
              aria-label="新建视图"
              onClick={() => setViewDialogOpen(true)}
            >
              <Plus size={14} />
            </button>
          ) : null}
        </div>
        <div className="database-toolbar">
          <label>
            <Search size={14} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索"
              aria-label="搜索数据库"
            />
          </label>
          {snapshot.database.isLocked ? (
            <span className="database-locked">
              <Lock size={13} /> 已锁定
            </span>
          ) : null}
          {editable ? (
            <button type="button" onClick={() => setPropertyDialog('new')}>
              <Plus size={14} /> 属性
            </button>
          ) : null}
          <button
            type="button"
            aria-label="视图设置"
            onClick={() => setViewMenuOpen((open) => !open)}
          >
            <Settings2 size={15} />
          </button>
          {viewMenuOpen ? (
            <ViewOptionsPanel
              view={activeView}
              properties={snapshot.properties}
              canEdit={editable}
              canLock={snapshot.database.role === 'space_admin'}
              locked={snapshot.database.isLocked}
              canDelete={editable && snapshot.views.length > 1}
              onUpdate={updateViewConfig}
              onToggleLock={toggleLock}
              onDelete={removeActiveView}
            />
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="database-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="database-view-container">
        {renderView(viewProps, (property) => editable && setPropertyDialog(property))}
      </div>
      {propertyDialog ? (
        <PropertyDialog
          databaseId={snapshot.database.id}
          organizationId={snapshot.database.organizationId}
          properties={snapshot.properties}
          property={propertyDialog === 'new' ? undefined : propertyDialog}
          onClose={() => setPropertyDialog(null)}
          onChanged={refresh}
        />
      ) : null}
      {viewDialogOpen ? (
        <ViewDialog
          databaseId={snapshot.database.id}
          onClose={() => setViewDialogOpen(false)}
          onCreated={async (view) => {
            await refresh();
            setActiveViewId(view.id);
          }}
        />
      ) : null}
    </section>
  );
}

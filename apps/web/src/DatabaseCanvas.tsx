import {
  Archive,
  Activity,
  BarChart3,
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Columns3,
  Copy,
  Download,
  ExternalLink,
  FileText,
  GalleryHorizontal,
  KanbanSquare,
  LayoutDashboard,
  LayoutTemplate,
  List,
  ListPlus,
  Lock,
  MapPinned,
  Plus,
  Play,
  Rss,
  RotateCcw,
  Search,
  Settings2,
  Star,
  Table2,
  Trash2,
  Zap,
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
  DatabaseFormLinkSummary,
  DatabaseAutomationAction,
  DatabaseAutomationRunSummary,
  DatabaseAutomationSummary,
  DatabaseAutomationTrigger,
  DatabasePropertySummary,
  DatabasePropertyType,
  DatabaseRowSummary,
  DatabaseSnapshot,
  DatabaseTemplateSummary,
  DatabaseViewSummary,
  DatabaseViewType,
  JsonValue,
  OrganizationMemberSummary,
} from '@rdocs/shared';

import {
  createDatabaseProperty,
  createDatabaseAutomation,
  createDatabaseFormLink,
  createDatabaseRow,
  createDatabaseRowFromTemplate,
  createDatabaseTemplate,
  createDatabaseView,
  deleteDatabaseProperty,
  deleteDatabaseAutomation,
  deleteDatabaseRow,
  deleteDatabaseTemplate,
  deleteDatabaseView,
  duplicateDatabaseRow,
  executeDatabaseButton,
  getArchivedDatabaseRows,
  getDatabase,
  listAttachments,
  listDatabaseAutomations,
  listDatabaseFormLinks,
  listOrganizationDatabases,
  listOrganizationMembers,
  updateDatabase,
  updateDatabaseAutomation,
  updateDatabaseProperty,
  updateDatabaseRow,
  updateDatabaseTemplate,
  updateDatabaseView,
  uploadAttachment,
  runDatabaseAutomation,
  revokeDatabaseFormLink,
} from './api';
import {
  applyDatabaseView,
  databaseAggregationValue,
  databaseCalendarDays,
  databaseDateRange,
  databaseViewFilters,
  databaseViewSorts,
  groupDatabaseRows,
  moveDatabaseDate,
  orderedVisibleDatabaseProperties,
  resizeDatabaseDate,
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

const AUTOMATION_TRIGGER_LABELS: Record<DatabaseAutomationTrigger, string> = {
  row_created: '新增记录时',
  row_updated: '记录更新时',
  property_changed: '指定属性变化时',
  form_submitted: '表单提交时',
  manual: '手动运行',
};

const AUTOMATION_ACTION_LABELS: Record<DatabaseAutomationAction, string> = {
  set_property: '设置属性',
  toggle_checkbox: '切换复选框',
  increment_number: '增加数字',
  archive_row: '归档记录',
  webhook: '发送 Webhook',
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
  if (typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
  }
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
  onButton,
}: {
  property: DatabasePropertySummary;
  value: JsonValue | undefined;
  disabled: boolean;
  onSave: (value: JsonValue) => Promise<void>;
  openPage?: string;
  organizationId?: string;
  rowPageId?: string;
  onButton?: () => Promise<void>;
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

  if (property.type === 'button') {
    const label =
      typeof property.config.label === 'string' && property.config.label.trim()
        ? property.config.label
        : property.name;
    return (
      <button
        className="database-button-cell"
        type="button"
        disabled={disabled || saving || !onButton}
        onClick={async () => {
          if (!onButton) return;
          setSaving(true);
          try {
            await onButton();
          } finally {
            setSaving(false);
          }
        }}
      >
        <Play size={11} fill="currentColor" /> {saving ? '执行中…' : label}
      </button>
    );
  }

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
  duplicateRow,
  executeButton,
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
                          onButton={() => executeButton(row, property)}
                        />
                      </td>
                    ))}
                    {canEdit ? (
                      <td className="database-row-actions">
                        <button
                          type="button"
                          title="复制记录"
                          aria-label={`复制${rowTitle(row, properties)}`}
                          onClick={() => duplicateRow(row)}
                        >
                          <Copy size={14} />
                        </button>
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
  allProperties: DatabasePropertySummary[];
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
  duplicateRow: (row: DatabaseRowSummary) => void;
  executeButton: (row: DatabaseRowSummary, property: DatabasePropertySummary) => Promise<void>;
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
  const groupCandidates = props.allProperties.filter((property) =>
    ['status', 'select', 'checkbox'].includes(property.type),
  );
  const groupProperty =
    props.allProperties.find((property) => property.id === props.view.config.groupPropertyId) ??
    groupCandidates[0];
  if (!groupProperty) {
    return (
      <ViewRequirement
        icon={<KanbanSquare size={24} />}
        text="添加状态、单选或复选框属性后即可分组看板。"
      />
    );
  }
  const groups = new Map<string, { value: JsonValue; rows: DatabaseRowSummary[] }>();
  if (groupProperty.type === 'checkbox') {
    groups.set('已选', { value: true, rows: [] });
    groups.set('未选', { value: false, rows: [] });
  }
  for (const option of optionNames(groupProperty)) {
    groups.set(option, { value: option, rows: [] });
  }
  for (const row of props.rows) {
    const current = row.values[groupProperty.id];
    const name =
      groupProperty.type === 'checkbox'
        ? current === true
          ? '已选'
          : '未选'
        : valueText(current) || '未分组';
    const group = groups.get(name) ?? { value: current ?? null, rows: [] };
    groups.set(name, { ...group, rows: [...group.rows, row] });
  }
  if (!groups.size || props.rows.some((row) => !valueText(row.values[groupProperty.id]))) {
    if (groupProperty.type !== 'checkbox' && !groups.has('未分组')) {
      groups.set('未分组', { value: null, rows: [] });
    }
  }
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
        {[...groups].map(([name, group]) => (
          <section
            key={name}
            onDragOver={(event) => {
              if (!props.canEdit) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (!props.canEdit) return;
              const row = props.rows.find(
                (candidate) =>
                  candidate.id === event.dataTransfer.getData('application/x-rdocs-row'),
              );
              if (row) void props.saveCell(row, groupProperty, group.value);
            }}
          >
            <header>
              <span>{name}</span>
              <small>{group.rows.length}</small>
            </header>
            {group.rows.map((row) => (
              <article
                key={row.id}
                draggable={props.canEdit}
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('application/x-rdocs-row', row.id);
                }}
              >
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
                        onButton={() => props.executeButton(row, property)}
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
  const dateCandidates = props.allProperties.filter((property) => DATE_TYPES.has(property.type));
  const dateProperty =
    props.allProperties.find((property) => property.id === props.view.config.datePropertyId) ??
    dateCandidates[0];
  if (!dateProperty) {
    return (
      <ViewRequirement icon={<CalendarDays size={24} />} text="添加日期属性后即可使用日历。" />
    );
  }
  const configuredMonth =
    typeof props.view.config.calendarMonth === 'string' &&
    /^\d{4}-\d{2}$/.test(props.view.config.calendarMonth)
      ? props.view.config.calendarMonth
      : new Date().toISOString().slice(0, 7);
  const days = databaseCalendarDays(configuredMonth);
  const rowsByDate = new Map<string, DatabaseRowSummary[]>();
  const unscheduled: DatabaseRowSummary[] = [];
  for (const row of props.rows) {
    const date = dateInputValue(row.values[dateProperty.id]);
    if (!date) unscheduled.push(row);
    else rowsByDate.set(date, [...(rowsByDate.get(date) ?? []), row]);
  }
  const moveMonth = (offset: number) => {
    const month = new Date(`${configuredMonth}-01T00:00:00.000Z`);
    month.setUTCMonth(month.getUTCMonth() + offset);
    void props.updateViewConfig({
      ...props.view.config,
      calendarMonth: month.toISOString().slice(0, 7),
    });
  };
  const moveRow = (rowId: string, date: string) => {
    if (!props.canEdit || dateProperty.type !== 'date') return;
    const row = props.rows.find((candidate) => candidate.id === rowId);
    if (row) {
      void props.saveCell(row, dateProperty, moveDatabaseDate(row.values[dateProperty.id], date));
    }
  };
  return (
    <div className="database-calendar-shell">
      <div className="database-calendar-toolbar">
        <PropertyPicker
          label="日期"
          value={dateProperty.id}
          properties={dateCandidates}
          onChange={(datePropertyId) =>
            void props.updateViewConfig({ ...props.view.config, datePropertyId })
          }
        />
        <div>
          <button type="button" aria-label="上个月" onClick={() => moveMonth(-1)}>
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() =>
              void props.updateViewConfig({
                ...props.view.config,
                calendarMonth: new Date().toISOString().slice(0, 7),
              })
            }
          >
            今天
          </button>
          <strong>
            {new Date(`${configuredMonth}-01T00:00:00.000Z`).toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: 'long',
              timeZone: 'UTC',
            })}
          </strong>
          <button type="button" aria-label="下个月" onClick={() => moveMonth(1)}>
            <ChevronRight size={15} />
          </button>
        </div>
      </div>
      <div className="database-calendar-weekdays" aria-hidden="true">
        {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((weekday) => (
          <span key={weekday}>{weekday}</span>
        ))}
      </div>
      <div className="database-calendar-grid">
        {days.map((day) => {
          const dayRows = rowsByDate.get(day.date) ?? [];
          return (
            <section
              key={day.date}
              className={`${day.inMonth ? '' : 'outside'} ${
                day.date === new Date().toISOString().slice(0, 10) ? 'today' : ''
              }`}
              onDragOver={(event) => {
                if (!props.canEdit || dateProperty.type !== 'date') return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
              }}
              onDrop={(event) => {
                event.preventDefault();
                moveRow(event.dataTransfer.getData('application/x-rdocs-row'), day.date);
              }}
            >
              <header>
                <time dateTime={day.date}>{Number(day.date.slice(-2))}</time>
                {props.canEdit && dateProperty.type === 'date' ? (
                  <button
                    type="button"
                    aria-label={`${day.date}新建记录`}
                    onClick={() => {
                      const title = titleProperty(props.properties);
                      void props.createRow({
                        ...(title ? { [title.id]: '未命名' } : {}),
                        [dateProperty.id]: day.date,
                      });
                    }}
                  >
                    <Plus size={12} />
                  </button>
                ) : null}
              </header>
              {dayRows.map((row) => (
                <a
                  key={row.id}
                  href={`/p/${encodeURIComponent(row.pageId)}`}
                  draggable={props.canEdit && dateProperty.type === 'date'}
                  onDragStart={(event) => {
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('application/x-rdocs-row', row.id);
                  }}
                >
                  {rowTitle(row, props.properties)}
                </a>
              ))}
            </section>
          );
        })}
      </div>
      {unscheduled.length ? (
        <details className="database-calendar-unscheduled">
          <summary>无日期 · {unscheduled.length}</summary>
          <div>
            {unscheduled.map((row) => (
              <a
                key={row.id}
                href={`/p/${encodeURIComponent(row.pageId)}`}
                draggable={props.canEdit && dateProperty.type === 'date'}
                onDragStart={(event) =>
                  event.dataTransfer.setData('application/x-rdocs-row', row.id)
                }
              >
                {rowTitle(row, props.properties)}
              </a>
            ))}
          </div>
        </details>
      ) : null}
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
  const dateCandidates = props.allProperties.filter((property) => DATE_TYPES.has(property.type));
  const dateProperty =
    props.allProperties.find((property) => property.id === props.view.config.datePropertyId) ??
    dateCandidates[0];
  if (!dateProperty)
    return <ViewRequirement icon={<Columns3 size={24} />} text="添加日期属性后即可使用时间线。" />;
  const datedRows = props.rows
    .map((row) => ({ row, range: databaseDateRange(row.values[dateProperty.id]) }))
    .filter(
      (item): item is { row: DatabaseRowSummary; range: { start: string; end: string } } =>
        item.range !== null,
    )
    .sort((left, right) => left.range.start.localeCompare(right.range.start));
  const unscheduled = props.rows.filter((row) => !databaseDateRange(row.values[dateProperty.id]));
  const timelineDays =
    props.view.config.timelineDays === 14 || props.view.config.timelineDays === 90
      ? props.view.config.timelineDays
      : 30;
  const configuredStart =
    typeof props.view.config.timelineStart === 'string' &&
    /^\d{4}-\d{2}-\d{2}$/.test(props.view.config.timelineStart)
      ? props.view.config.timelineStart
      : (datedRows[0]?.range.start ?? new Date().toISOString().slice(0, 10));
  const startTime = Date.parse(`${configuredStart}T00:00:00.000Z`);
  const axisDays = Array.from({ length: timelineDays }, (_, index) => {
    const day = new Date(startTime);
    day.setUTCDate(day.getUTCDate() + index);
    return day.toISOString().slice(0, 10);
  });
  const shiftWindow = (offset: number) => {
    const date = new Date(startTime);
    date.setUTCDate(date.getUTCDate() + offset);
    void props.updateViewConfig({
      ...props.view.config,
      timelineStart: date.toISOString().slice(0, 10),
      timelineDays,
    });
  };
  const dateOffset = (date: string) =>
    Math.round((Date.parse(`${date}T00:00:00.000Z`) - startTime) / 86_400_000);
  const updateRange = (row: DatabaseRowSummary, mode: 'move' | 'start' | 'end', date: string) => {
    if (!props.canEdit || dateProperty.type !== 'date') return;
    const value =
      mode === 'move'
        ? moveDatabaseDate(row.values[dateProperty.id], date)
        : resizeDatabaseDate(row.values[dateProperty.id], mode, date);
    void props.saveCell(row, dateProperty, value);
  };
  const dropOnTrack = (event: React.DragEvent<HTMLDivElement>) => {
    if (!props.canEdit || dateProperty.type !== 'date') return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    const index = Math.max(
      0,
      Math.min(
        timelineDays - 1,
        Math.floor(((event.clientX - bounds.left) / bounds.width) * timelineDays),
      ),
    );
    try {
      const payload = JSON.parse(event.dataTransfer.getData('application/x-rdocs-timeline')) as {
        rowId?: unknown;
        mode?: unknown;
      };
      const row = props.rows.find((candidate) => candidate.id === payload.rowId);
      const mode =
        payload.mode === 'start' || payload.mode === 'end' ? payload.mode : ('move' as const);
      if (row) updateRange(row, mode, axisDays[index]!);
    } catch {
      // Ignore drags that do not originate from this timeline.
    }
  };
  return (
    <div
      className="database-timeline-view"
      style={{ '--timeline-days': timelineDays } as React.CSSProperties}
    >
      <div className="database-timeline-toolbar">
        <PropertyPicker
          label="时间"
          value={dateProperty.id}
          properties={dateCandidates}
          onChange={(datePropertyId) =>
            void props.updateViewConfig({ ...props.view.config, datePropertyId })
          }
        />
        <div>
          <button type="button" aria-label="上一时间段" onClick={() => shiftWindow(-timelineDays)}>
            <ChevronLeft size={15} />
          </button>
          <button
            type="button"
            onClick={() =>
              void props.updateViewConfig({
                ...props.view.config,
                timelineStart: new Date().toISOString().slice(0, 10),
                timelineDays,
              })
            }
          >
            今天
          </button>
          <button type="button" aria-label="下一时间段" onClick={() => shiftWindow(timelineDays)}>
            <ChevronRight size={15} />
          </button>
          <select
            aria-label="时间线范围"
            value={timelineDays}
            onChange={(event) =>
              void props.updateViewConfig({
                ...props.view.config,
                timelineStart: configuredStart,
                timelineDays: Number(event.target.value),
              })
            }
          >
            <option value={14}>2 周</option>
            <option value={30}>1 月</option>
            <option value={90}>1 季度</option>
          </select>
        </div>
      </div>
      <div className="database-timeline-axis">
        <span>记录</span>
        <div>
          {axisDays.map((date) => (
            <time key={date} dateTime={date} title={date}>
              {date.slice(5)}
            </time>
          ))}
        </div>
      </div>
      {datedRows.map(({ row, range }) => {
        const start = Math.max(0, dateOffset(range.start));
        const end = Math.min(timelineDays - 1, dateOffset(range.end));
        const visible = end >= 0 && start < timelineDays;
        return (
          <article key={row.id}>
            <a href={`/p/${encodeURIComponent(row.pageId)}`}>{rowTitle(row, props.properties)}</a>
            <div
              className="database-timeline-track"
              onDragOver={(event) => {
                if (props.canEdit && dateProperty.type === 'date') event.preventDefault();
              }}
              onDrop={dropOnTrack}
            >
              {visible ? (
                <div
                  className="database-timeline-bar"
                  draggable={props.canEdit && dateProperty.type === 'date'}
                  style={
                    {
                      '--timeline-left': `${(start / timelineDays) * 100}%`,
                      '--timeline-width': `${((Math.max(end, start) - start + 1) / timelineDays) * 100}%`,
                    } as React.CSSProperties
                  }
                  onDragStart={(event) =>
                    event.dataTransfer.setData(
                      'application/x-rdocs-timeline',
                      JSON.stringify({ rowId: row.id, mode: 'move' }),
                    )
                  }
                  title={`${range.start} → ${range.end}`}
                >
                  <button
                    type="button"
                    draggable={props.canEdit && dateProperty.type === 'date'}
                    aria-label={`调整“${rowTitle(row, props.properties)}”开始日期`}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer.setData(
                        'application/x-rdocs-timeline',
                        JSON.stringify({ rowId: row.id, mode: 'start' }),
                      );
                    }}
                  />
                  <span>{rowTitle(row, props.properties)}</span>
                  <button
                    type="button"
                    draggable={props.canEdit && dateProperty.type === 'date'}
                    aria-label={`调整“${rowTitle(row, props.properties)}”结束日期`}
                    onDragStart={(event) => {
                      event.stopPropagation();
                      event.dataTransfer.setData(
                        'application/x-rdocs-timeline',
                        JSON.stringify({ rowId: row.id, mode: 'end' }),
                      );
                    }}
                  />
                </div>
              ) : null}
            </div>
          </article>
        );
      })}
      {unscheduled.length ? (
        <details className="database-timeline-unscheduled">
          <summary>无日期 · {unscheduled.length}</summary>
          <div>
            {unscheduled.map((row) => (
              <a
                key={row.id}
                href={`/p/${encodeURIComponent(row.pageId)}`}
                draggable={props.canEdit && dateProperty.type === 'date'}
                onDragStart={(event) =>
                  event.dataTransfer.setData(
                    'application/x-rdocs-timeline',
                    JSON.stringify({ rowId: row.id, mode: 'move' }),
                  )
                }
              >
                {rowTitle(row, props.properties)}
              </a>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function ChartDatabaseView(props: DatabaseViewProps) {
  const candidates = props.allProperties.filter((property) =>
    ['select', 'status', 'checkbox', 'person'].includes(property.type),
  );
  const groupProperty =
    props.allProperties.find((property) => property.id === props.view.config.groupPropertyId) ??
    candidates[0];
  if (!groupProperty)
    return (
      <ViewRequirement icon={<BarChart3 size={24} />} text="添加状态或选项属性后即可创建图表。" />
    );
  const numericProperties = props.allProperties.filter((property) => property.type === 'number');
  const valueProperty =
    props.allProperties.find((property) => property.id === props.view.config.valuePropertyId) ??
    numericProperties[0];
  const calculation =
    props.view.config.calculation === 'sum' || props.view.config.calculation === 'average'
      ? props.view.config.calculation
      : 'count';
  const chartType =
    props.view.config.chartType === 'line' || props.view.config.chartType === 'donut'
      ? props.view.config.chartType
      : 'bar';
  const groupedRows = new Map<string, DatabaseRowSummary[]>();
  for (const row of props.rows) {
    const key = valueText(row.values[groupProperty.id]) || '空';
    groupedRows.set(key, [...(groupedRows.get(key) ?? []), row]);
  }
  const points = [...groupedRows].map(([label, rows]) => {
    const numbers = valueProperty
      ? rows
          .map((row) => row.values[valueProperty.id])
          .filter((value): value is number => typeof value === 'number')
      : [];
    const value =
      calculation === 'sum'
        ? numbers.reduce((total, number) => total + number, 0)
        : calculation === 'average'
          ? numbers.length
            ? numbers.reduce((total, number) => total + number, 0) / numbers.length
            : 0
          : rows.length;
    return { label, value, rows };
  });
  const maximum = Math.max(1, ...points.map((point) => point.value));
  const total = points.reduce((sum, point) => sum + point.value, 0);
  const drillInto = (label: string) => {
    const filters = databaseViewFilters(props.view.config).filter(
      (filter) => filter.propertyId !== groupProperty.id,
    );
    void props.updateViewConfig({
      ...props.view.config,
      filters: [
        ...filters.map(({ propertyId, operator, value }) => ({ propertyId, operator, value })),
        { propertyId: groupProperty.id, operator: 'equals', value: label === '空' ? null : label },
      ],
    });
  };
  const exportCsv = () => {
    const csv = [
      ['分组', calculation === 'count' ? '记录数' : (valueProperty?.name ?? '值')],
      ...points.map((point) => [point.label, String(point.value)]),
    ]
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
      .join('\n');
    const url = URL.createObjectURL(new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${props.view.name}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="database-chart-view">
      <div className="database-chart-toolbar">
        <PropertyPicker
          label="分组"
          value={groupProperty.id}
          properties={candidates}
          onChange={(groupPropertyId) =>
            void props.updateViewConfig({ ...props.view.config, groupPropertyId })
          }
        />
        <label>
          图表
          <select
            value={chartType}
            onChange={(event) =>
              void props.updateViewConfig({ ...props.view.config, chartType: event.target.value })
            }
          >
            <option value="bar">柱状图</option>
            <option value="line">折线图</option>
            <option value="donut">环形图</option>
          </select>
        </label>
        <label>
          计算
          <select
            value={calculation}
            onChange={(event) =>
              void props.updateViewConfig({ ...props.view.config, calculation: event.target.value })
            }
          >
            <option value="count">记录数</option>
            <option value="sum">求和</option>
            <option value="average">平均值</option>
          </select>
        </label>
        {calculation !== 'count' ? (
          <PropertyPicker
            label="数值"
            value={valueProperty?.id ?? ''}
            properties={numericProperties}
            onChange={(valuePropertyId) =>
              void props.updateViewConfig({ ...props.view.config, valuePropertyId })
            }
          />
        ) : null}
        <button type="button" onClick={exportCsv}>
          <Download size={14} /> 导出 CSV
        </button>
      </div>
      {chartType === 'line' ? (
        <div className="database-line-chart">
          <svg viewBox="0 0 720 260" role="img" aria-label={`${props.view.name}折线图`}>
            <polyline
              points={points
                .map(
                  (point, index) =>
                    `${60 + (index * 620) / Math.max(1, points.length - 1)},${220 - (point.value / maximum) * 180}`,
                )
                .join(' ')}
            />
            {points.map((point, index) => (
              <g
                key={point.label}
                role="button"
                tabIndex={0}
                onClick={() => drillInto(point.label)}
                onKeyDown={(event) => event.key === 'Enter' && drillInto(point.label)}
              >
                <circle
                  cx={60 + (index * 620) / Math.max(1, points.length - 1)}
                  cy={220 - (point.value / maximum) * 180}
                  r="6"
                />
                <text x={60 + (index * 620) / Math.max(1, points.length - 1)} y="245">
                  {point.label.slice(0, 10)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      ) : chartType === 'donut' ? (
        <div className="database-donut-chart">
          <div
            className="database-donut"
            style={{
              background: `conic-gradient(${points
                .reduce<{ offset: number; stops: string[] }>(
                  (state, point, index) => {
                    const start = state.offset;
                    const end = start + (total ? (point.value / total) * 100 : 0);
                    return {
                      offset: end,
                      stops: [
                        ...state.stops,
                        `hsl(${(index * 67) % 360} 48% 62%) ${start}% ${end}%`,
                      ],
                    };
                  },
                  { offset: 0, stops: [] },
                )
                .stops.join(', ')})`,
            }}
          >
            <span>{total.toLocaleString()}</span>
          </div>
          <div className="database-chart-legend">
            {points.map((point, index) => (
              <button key={point.label} type="button" onClick={() => drillInto(point.label)}>
                <i style={{ background: `hsl(${(index * 67) % 360} 48% 62%)` }} />
                <span>{point.label}</span>
                <strong>{point.value.toLocaleString()}</strong>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="database-bars">
          {points.map((point) => (
            <button key={point.label} type="button" onClick={() => drillInto(point.label)}>
              <span>{point.label}</span>
              <i style={{ '--bar-size': point.value / maximum } as React.CSSProperties} />
              <strong>{point.value.toLocaleString()}</strong>
            </button>
          ))}
        </div>
      )}
      <p className="database-chart-hint">点击图形即可把当前分组作为视图筛选条件。</p>
    </div>
  );
}

function FormPublishingPanel(props: DatabaseViewProps) {
  const [links, setLinks] = useState<DatabaseFormLinkSummary[]>([]);
  const [expiresInDays, setExpiresInDays] = useState<number | null>(30);
  const [createdPath, setCreatedPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!props.canEdit) return;
    let active = true;
    listDatabaseFormLinks(props.view.databaseId)
      .then((result) => active && setLinks(result.links))
      .catch(
        (reason: unknown) =>
          active && setError(reason instanceof Error ? reason.message : '无法读取公开链接'),
      );
    return () => {
      active = false;
    };
  }, [props.canEdit, props.view.databaseId]);

  if (!props.canEdit) return null;
  const createLink = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createDatabaseFormLink(
        props.view.databaseId,
        props.view.id,
        expiresInDays,
      );
      setLinks((current) => [result.link, ...current]);
      setCreatedPath(result.path);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法发布表单');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (link: DatabaseFormLinkSummary) => {
    if (busy || !window.confirm('关闭这个表单链接？已打开的链接将立即失效。')) return;
    setBusy(true);
    try {
      const result = await revokeDatabaseFormLink(link.id);
      setLinks((current) =>
        current.map((candidate) =>
          candidate.id === link.id
            ? { ...candidate, status: 'revoked', revokedAt: result.revokedAt }
            : candidate,
        ),
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法关闭表单链接');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="database-form-publishing">
      <header>
        <div>
          <strong>公开收集</strong>
          <p>任何拿到链接的人都能提交，但不会获得数据库读取或编辑权限。</p>
        </div>
        <div>
          <select
            aria-label="表单链接有效期"
            value={expiresInDays ?? 0}
            onChange={(event) =>
              setExpiresInDays(event.target.value === '0' ? null : Number(event.target.value))
            }
          >
            <option value={7}>7 天</option>
            <option value={30}>30 天</option>
            <option value={90}>90 天</option>
            <option value={0}>永久</option>
          </select>
          <button type="button" disabled={busy} onClick={() => void createLink()}>
            发布表单
          </button>
        </div>
      </header>
      {createdPath ? (
        <div className="database-form-created-link">
          <input readOnly value={`${window.location.origin}${createdPath}`} />
          <button
            type="button"
            onClick={() =>
              void navigator.clipboard.writeText(`${window.location.origin}${createdPath}`)
            }
          >
            <Copy size={14} /> 复制
          </button>
        </div>
      ) : null}
      {links.map((link) => (
        <div key={link.id} className="database-form-link-row">
          <span className={link.status}>{link.status === 'active' ? '收集中' : '已关闭'}</span>
          <small>
            创建于 {new Date(link.createdAt).toLocaleString()}
            {link.expiresAt
              ? ` · ${new Date(link.expiresAt).toLocaleDateString()} 到期`
              : ' · 永久'}
          </small>
          {link.status === 'active' ? (
            <button type="button" disabled={busy} onClick={() => void revoke(link)}>
              关闭
            </button>
          ) : null}
        </div>
      ))}
      {error ? <p className="database-error">{error}</p> : null}
    </section>
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
  const requiredPropertyIds = new Set(
    Array.isArray(props.view.config.requiredPropertyIds)
      ? props.view.config.requiredPropertyIds.filter(
          (value): value is string => typeof value === 'string',
        )
      : [],
  );
  return (
    <>
      <FormPublishingPanel {...props} />
      <form className="database-form-view" onSubmit={(event) => void submit(event)}>
        <header>
          <ListPlus size={22} />
          <div>
            <h3>
              {typeof props.view.config.formTitle === 'string'
                ? props.view.config.formTitle
                : props.view.name}
            </h3>
            <p>
              {typeof props.view.config.formDescription === 'string'
                ? props.view.config.formDescription
                : '提交内容会成为数据库中的一条记录。'}
            </p>
          </div>
        </header>
        {editable.map((property) => {
          const propertyValue = values[property.id];
          return (
            <label key={property.id}>
              <span>
                {property.name} {requiredPropertyIds.has(property.id) ? <b>*</b> : null}
              </span>
              {property.type === 'checkbox' ? (
                <input
                  type="checkbox"
                  checked={propertyValue === true}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [property.id]: event.target.checked }))
                  }
                />
              ) : property.type === 'select' || property.type === 'status' ? (
                <select
                  required={requiredPropertyIds.has(property.id)}
                  value={typeof propertyValue === 'string' ? propertyValue : ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [property.id]: event.target.value }))
                  }
                >
                  <option value="">请选择</option>
                  {optionNames(property).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : property.type === 'multi_select' ? (
                <div className="public-form-options">
                  {optionNames(property).map((option) => {
                    const selected = Array.isArray(propertyValue)
                      ? propertyValue.filter((value): value is string => typeof value === 'string')
                      : [];
                    return (
                      <label key={option}>
                        <input
                          type="checkbox"
                          checked={selected.includes(option)}
                          onChange={(event) =>
                            setValues((current) => ({
                              ...current,
                              [property.id]: event.target.checked
                                ? [...selected, option]
                                : selected.filter((value) => value !== option),
                            }))
                          }
                        />
                        <span>{option}</span>
                      </label>
                    );
                  })}
                </div>
              ) : property.type === 'text' ? (
                <textarea
                  required={requiredPropertyIds.has(property.id)}
                  value={typeof propertyValue === 'string' ? propertyValue : ''}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [property.id]: event.target.value }))
                  }
                />
              ) : (
                <input
                  type={
                    property.type === 'number'
                      ? 'number'
                      : property.type === 'date'
                        ? 'date'
                        : 'text'
                  }
                  required={requiredPropertyIds.has(property.id)}
                  value={toInputValue(property, propertyValue)}
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [property.id]: fromInputValue(property, event.target.value),
                    }))
                  }
                />
              )}
            </label>
          );
        })}
        <button type="submit" disabled={!props.canEdit || busy}>
          {submitted ? <Check size={15} /> : null}
          {submitted
            ? '已提交'
            : busy
              ? '提交中…'
              : typeof props.view.config.submitLabel === 'string'
                ? props.view.config.submitLabel
                : '提交'}
        </button>
      </form>
    </>
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
  const places = props.allProperties.filter((property) => property.type === 'place');
  const placeProperty =
    props.allProperties.find((property) => property.id === props.view.config.placePropertyId) ??
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
      {view.type === 'form' ? (
        <section className="database-form-settings">
          <header>
            <strong>表单内容</strong>
          </header>
          <label>
            <span>标题</span>
            <input
              defaultValue={
                typeof view.config.formTitle === 'string' ? view.config.formTitle : view.name
              }
              disabled={!canEdit}
              onBlur={(event) =>
                void onUpdate({ ...view.config, formTitle: event.target.value.trim() || view.name })
              }
            />
          </label>
          <label>
            <span>说明</span>
            <textarea
              defaultValue={
                typeof view.config.formDescription === 'string' ? view.config.formDescription : ''
              }
              disabled={!canEdit}
              onBlur={(event) =>
                void onUpdate({ ...view.config, formDescription: event.target.value.trim() })
              }
            />
          </label>
          <label>
            <span>提交按钮</span>
            <input
              defaultValue={
                typeof view.config.submitLabel === 'string' ? view.config.submitLabel : '提交'
              }
              disabled={!canEdit}
              onBlur={(event) =>
                void onUpdate({ ...view.config, submitLabel: event.target.value.trim() || '提交' })
              }
            />
          </label>
          <label>
            <span>成功提示</span>
            <input
              defaultValue={
                typeof view.config.successMessage === 'string'
                  ? view.config.successMessage
                  : '提交成功，感谢填写。'
              }
              disabled={!canEdit}
              onBlur={(event) =>
                void onUpdate({
                  ...view.config,
                  successMessage: event.target.value.trim() || '提交成功，感谢填写。',
                })
              }
            />
          </label>
          <strong className="database-form-required-title">必填字段</strong>
          {properties
            .filter((property) => FORM_PROPERTY_TYPES.has(property.type))
            .map((property) => {
              const required = new Set(
                Array.isArray(view.config.requiredPropertyIds)
                  ? view.config.requiredPropertyIds.filter(
                      (value): value is string => typeof value === 'string',
                    )
                  : [],
              );
              return (
                <label key={property.id} className="database-dialog-checkbox">
                  <input
                    type="checkbox"
                    checked={required.has(property.id)}
                    disabled={!canEdit}
                    onChange={(event) => {
                      if (event.target.checked) required.add(property.id);
                      else required.delete(property.id);
                      void onUpdate({ ...view.config, requiredPropertyIds: [...required] });
                    }}
                  />
                  {property.name}
                </label>
              );
            })}
        </section>
      ) : null}
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
  const [buttonLabel, setButtonLabel] = useState(
    typeof property?.config.label === 'string' ? property.config.label : '执行',
  );
  const [buttonAction, setButtonAction] = useState(
    typeof property?.config.action === 'string' ? property.config.action : 'set_property',
  );
  const [buttonTargetPropertyId, setButtonTargetPropertyId] = useState(
    typeof property?.config.targetPropertyId === 'string' ? property.config.targetPropertyId : '',
  );
  const [buttonValue, setButtonValue] = useState(() => {
    const value = property?.config.value;
    if (Array.isArray(value)) return value.map(valueText).join(', ');
    return value === null || value === undefined ? '' : valueText(value);
  });
  const [buttonIncrement, setButtonIncrement] = useState(
    typeof property?.config.increment === 'number' ? String(property.config.increment) : '1',
  );
  const [buttonUrl, setButtonUrl] = useState(
    typeof property?.config.url === 'string' ? property.config.url : 'https://',
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
    if (type === 'button') {
      config.label = buttonLabel.trim() || name;
      config.action = buttonAction;
      if (
        ['set_property', 'toggle_checkbox', 'set_date_now', 'increment_number'].includes(
          buttonAction,
        )
      ) {
        config.targetPropertyId = buttonTargetPropertyId;
      }
      if (buttonAction === 'set_property') {
        const target = properties.find((candidate) => candidate.id === buttonTargetPropertyId);
        config.value =
          target?.type === 'number'
            ? Number(buttonValue)
            : target?.type === 'checkbox'
              ? buttonValue === 'true'
              : target?.type === 'multi_select'
                ? buttonValue
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean)
                : buttonValue;
      }
      if (buttonAction === 'increment_number') config.increment = Number(buttonIncrement) || 1;
      if (buttonAction === 'open_url') config.url = buttonUrl.trim();
    }
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
                <option value="percent_checked">已勾选百分比</option>
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
        {type === 'button' ? (
          <>
            <label>
              按钮文字
              <input
                value={buttonLabel}
                maxLength={100}
                onChange={(event) => setButtonLabel(event.target.value)}
              />
            </label>
            <label>
              执行动作
              <select
                value={buttonAction}
                onChange={(event) => setButtonAction(event.target.value)}
              >
                <option value="set_property">设置属性</option>
                <option value="toggle_checkbox">切换复选框</option>
                <option value="set_date_now">设置为当前时间</option>
                <option value="increment_number">增加数字</option>
                <option value="duplicate_row">复制记录</option>
                <option value="archive_row">归档记录</option>
                <option value="open_url">打开链接</option>
              </select>
            </label>
            {['set_property', 'toggle_checkbox', 'set_date_now', 'increment_number'].includes(
              buttonAction,
            ) ? (
              <label>
                目标属性
                <select
                  value={buttonTargetPropertyId}
                  onChange={(event) => setButtonTargetPropertyId(event.target.value)}
                >
                  <option value="">请选择</option>
                  {properties
                    .filter((candidate) => {
                      if (buttonAction === 'toggle_checkbox') return candidate.type === 'checkbox';
                      if (buttonAction === 'set_date_now') return candidate.type === 'date';
                      if (buttonAction === 'increment_number') return candidate.type === 'number';
                      return [
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
                      ].includes(candidate.type);
                    })
                    .map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.name}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {buttonAction === 'set_property' ? (
              <label>
                设置为
                <input
                  value={buttonValue}
                  onChange={(event) => setButtonValue(event.target.value)}
                  placeholder="多选值使用逗号分隔"
                />
              </label>
            ) : null}
            {buttonAction === 'increment_number' ? (
              <label>
                增加数值
                <input
                  type="number"
                  value={buttonIncrement}
                  onChange={(event) => setButtonIncrement(event.target.value)}
                />
              </label>
            ) : null}
            {buttonAction === 'open_url' ? (
              <label>
                链接
                <input
                  type="url"
                  value={buttonUrl}
                  onChange={(event) => setButtonUrl(event.target.value)}
                  placeholder="https://example.com"
                />
              </label>
            ) : null}
          </>
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

function DatabaseAutomationDialog({
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
  const [name, setName] = useState('新自动化');
  const [triggerType, setTriggerType] = useState<DatabaseAutomationTrigger>('property_changed');
  const [triggerPropertyId, setTriggerPropertyId] = useState(snapshot.properties[0]?.id ?? '');
  const [actionType, setActionType] = useState<DatabaseAutomationAction>('set_property');
  const [targetPropertyId, setTargetPropertyId] = useState(snapshot.properties[0]?.id ?? '');
  const [actionValue, setActionValue] = useState('');
  const [increment, setIncrement] = useState('1');
  const [webhookUrl, setWebhookUrl] = useState('https://');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [manualRowId, setManualRowId] = useState(snapshot.rows[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await listDatabaseAutomations(snapshot.database.id);
    setAutomations(result.automations);
    setRuns(result.runs);
  }, [snapshot.database.id]);

  useEffect(() => {
    let active = true;
    void load().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : '无法读取自动化');
    });
    return () => {
      active = false;
    };
  }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const triggerConfig: Record<string, JsonValue> =
      triggerType === 'property_changed' ? { propertyId: triggerPropertyId } : {};
    const targetProperty = snapshot.properties.find((property) => property.id === targetPropertyId);
    let actionConfig: Record<string, JsonValue> = {};
    if (actionType === 'webhook') {
      actionConfig = {
        url: webhookUrl,
        ...(webhookSecret ? { secret: webhookSecret } : {}),
      };
    } else if (actionType !== 'archive_row') {
      actionConfig.targetPropertyId = targetPropertyId;
      if (actionType === 'increment_number') actionConfig.increment = Number(increment) || 1;
      if (actionType === 'set_property') {
        actionConfig.value =
          targetProperty?.type === 'number'
            ? Number(actionValue)
            : targetProperty?.type === 'checkbox'
              ? actionValue === 'true'
              : targetProperty?.type === 'multi_select'
                ? actionValue
                    .split(',')
                    .map((item) => item.trim())
                    .filter(Boolean)
                : actionValue;
      }
    }
    try {
      await createDatabaseAutomation(snapshot.database.id, {
        name,
        triggerType,
        triggerConfig,
        actionType,
        actionConfig,
      });
      await load();
      setName('新自动化');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建自动化');
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

  const remove = async (automation: DatabaseAutomationSummary) => {
    if (busy || !window.confirm(`删除自动化“${automation.name}”及其运行记录？`)) return;
    setBusy(true);
    try {
      await deleteDatabaseAutomation(snapshot.database.id, automation.id);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除自动化');
    } finally {
      setBusy(false);
    }
  };

  const runManual = async (automation: DatabaseAutomationSummary) => {
    if (busy || !manualRowId) return;
    setBusy(true);
    setError(null);
    try {
      const result = await runDatabaseAutomation(snapshot.database.id, automation.id, manualRowId);
      setRuns((current) => [result.run, ...current]);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法运行自动化');
    } finally {
      setBusy(false);
    }
  };

  const targetCandidates = snapshot.properties.filter((property) => {
    if (actionType === 'toggle_checkbox') return property.type === 'checkbox';
    if (actionType === 'increment_number') return property.type === 'number';
    return FORM_PROPERTY_TYPES.has(property.type);
  });
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="rdocs-dialog database-automation-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>自动化</h2>
            <p>触发器和动作在服务端运行，每次执行都有幂等记录与结果。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="database-automation-list">
          {automations.map((automation) => (
            <article key={automation.id}>
              <span className={automation.enabled ? 'enabled' : ''}>
                <Zap size={14} />
              </span>
              <div>
                <strong>{automation.name}</strong>
                <small>
                  {AUTOMATION_TRIGGER_LABELS[automation.triggerType]} →{' '}
                  {AUTOMATION_ACTION_LABELS[automation.actionType]}
                </small>
              </div>
              {automation.triggerType === 'manual' ? (
                <button
                  type="button"
                  disabled={busy || !manualRowId}
                  onClick={() => void runManual(automation)}
                >
                  运行
                </button>
              ) : null}
              <button type="button" disabled={busy} onClick={() => void toggle(automation)}>
                {automation.enabled ? '暂停' : '启用'}
              </button>
              <button
                className="danger"
                type="button"
                aria-label={`删除自动化${automation.name}`}
                disabled={busy}
                onClick={() => void remove(automation)}
              >
                <Trash2 size={14} />
              </button>
            </article>
          ))}
          {!automations.length ? <p>还没有自动化。</p> : null}
        </div>
        <form onSubmit={(event) => void create(event)}>
          <h3>新建自动化</h3>
          <div className="database-automation-grid">
            <label>
              名称
              <input
                value={name}
                required
                maxLength={100}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              触发器
              <select
                value={triggerType}
                onChange={(event) =>
                  setTriggerType(event.target.value as DatabaseAutomationTrigger)
                }
              >
                {Object.entries(AUTOMATION_TRIGGER_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {triggerType === 'property_changed' ? (
              <label>
                触发属性
                <select
                  value={triggerPropertyId}
                  onChange={(event) => setTriggerPropertyId(event.target.value)}
                >
                  {snapshot.properties.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label>
              动作
              <select
                value={actionType}
                onChange={(event) => setActionType(event.target.value as DatabaseAutomationAction)}
              >
                {Object.entries(AUTOMATION_ACTION_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {!['archive_row', 'webhook'].includes(actionType) ? (
              <label>
                目标属性
                <select
                  value={targetPropertyId}
                  onChange={(event) => setTargetPropertyId(event.target.value)}
                >
                  <option value="">请选择</option>
                  {targetCandidates.map((property) => (
                    <option key={property.id} value={property.id}>
                      {property.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {actionType === 'set_property' ? (
              <label>
                设置为
                <input
                  value={actionValue}
                  onChange={(event) => setActionValue(event.target.value)}
                />
              </label>
            ) : null}
            {actionType === 'increment_number' ? (
              <label>
                增加
                <input
                  type="number"
                  value={increment}
                  onChange={(event) => setIncrement(event.target.value)}
                />
              </label>
            ) : null}
            {actionType === 'webhook' ? (
              <>
                <label>
                  HTTPS Webhook
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={(event) => setWebhookUrl(event.target.value)}
                  />
                </label>
                <label>
                  签名密钥（可选）
                  <input
                    type="password"
                    value={webhookSecret}
                    minLength={16}
                    onChange={(event) => setWebhookSecret(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            {triggerType === 'manual' ? (
              <label>
                手动运行记录
                <select
                  value={manualRowId}
                  onChange={(event) => setManualRowId(event.target.value)}
                >
                  <option value="">请选择</option>
                  {snapshot.rows.map((row) => (
                    <option key={row.id} value={row.id}>
                      {rowTitle(row, snapshot.properties)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {error ? <p className="dialog-error">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={onClose}>
              完成
            </button>
            <button className="primary-button" type="submit" disabled={busy}>
              {busy ? '保存中…' : '创建自动化'}
            </button>
          </div>
        </form>
        <details className="database-automation-runs">
          <summary>
            <Activity size={14} /> 最近运行 · {runs.length}
          </summary>
          {runs.slice(0, 20).map((run) => (
            <div key={run.id}>
              <span className={run.status}>{run.status}</span>
              <time>{new Date(run.startedAt).toLocaleString()}</time>
              <small>
                {run.errorMessage || (run.responseCode ? `HTTP ${run.responseCode}` : '完成')}
              </small>
            </div>
          ))}
        </details>
      </section>
    </div>
  );
}

function DatabaseTemplateDialog({
  snapshot,
  onChanged,
  onClose,
}: {
  snapshot: DatabaseSnapshot;
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState('新模板');
  const [description, setDescription] = useState('');
  const [sourceRowId, setSourceRowId] = useState(snapshot.rows[0]?.id ?? '');
  const [isDefault, setIsDefault] = useState(snapshot.templates.length === 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!sourceRowId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createDatabaseTemplate(snapshot.database.id, {
        name,
        description,
        sourceRowId,
        isDefault,
      });
      await onChanged();
      setName('新模板');
      setDescription('');
      setIsDefault(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建模板');
    } finally {
      setBusy(false);
    }
  };
  const makeDefault = async (template: DatabaseTemplateSummary) => {
    if (busy || template.isDefault) return;
    setBusy(true);
    setError(null);
    try {
      await updateDatabaseTemplate(snapshot.database.id, template.id, { isDefault: true });
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法设置默认模板');
    } finally {
      setBusy(false);
    }
  };
  const remove = async (template: DatabaseTemplateSummary) => {
    if (busy || !window.confirm(`删除模板“${template.name}”？已有记录不会受影响。`)) return;
    setBusy(true);
    setError(null);
    try {
      await deleteDatabaseTemplate(snapshot.database.id, template.id);
      await onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除模板');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="rdocs-dialog database-template-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>数据库模板</h2>
            <p>保存记录的属性、页面正文和私有附件，之后一键创建完整副本。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        <div className="database-template-list">
          {snapshot.templates.map((template) => (
            <article key={template.id}>
              <span className="database-template-icon">
                <LayoutTemplate size={16} />
              </span>
              <div>
                <strong>{template.name}</strong>
                <small>{template.description || '包含属性和页面内容'}</small>
              </div>
              {template.isDefault ? (
                <span className="database-template-default">
                  <Star size={12} /> 默认
                </span>
              ) : (
                <button type="button" disabled={busy} onClick={() => void makeDefault(template)}>
                  设为默认
                </button>
              )}
              <a href={`/p/${encodeURIComponent(template.pageId)}`}>编辑内容</a>
              <button
                className="danger"
                type="button"
                aria-label={`删除模板${template.name}`}
                disabled={busy}
                onClick={() => void remove(template)}
              >
                <Trash2 size={14} />
              </button>
            </article>
          ))}
          {!snapshot.templates.length ? <p>还没有模板。先选择一条记录作为样板。</p> : null}
        </div>
        <form onSubmit={(event) => void create(event)}>
          <h3>从现有记录创建</h3>
          <div className="database-template-fields">
            <label>
              模板名称
              <input
                value={name}
                maxLength={100}
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              源记录
              <select
                value={sourceRowId}
                required
                onChange={(event) => setSourceRowId(event.target.value)}
              >
                <option value="">请选择</option>
                {snapshot.rows.map((row) => (
                  <option key={row.id} value={row.id}>
                    {rowTitle(row, snapshot.properties)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label>
            说明
            <input
              value={description}
              maxLength={500}
              placeholder="例如：新项目默认结构"
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="database-dialog-checkbox">
            <input
              type="checkbox"
              checked={isDefault}
              onChange={(event) => setIsDefault(event.target.checked)}
            />
            设为默认模板
          </label>
          {error ? <p className="dialog-error">{error}</p> : null}
          <div className="dialog-actions">
            <button type="button" onClick={onClose} disabled={busy}>
              完成
            </button>
            <button className="primary-button" type="submit" disabled={busy || !sourceRowId}>
              {busy ? '保存中…' : '创建模板'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function DatabaseTrashDialog({
  snapshot,
  busyRowId,
  onRestore,
  onClose,
}: {
  snapshot: DatabaseSnapshot | null;
  busyRowId: string | null;
  onRestore: (row: DatabaseRowSummary) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="dialog-backdrop" role="presentation">
      <section className="rdocs-dialog database-trash-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>已归档记录</h2>
            <p>恢复后会回到数据库，并保留原来的唯一 ID。</p>
          </div>
          <button type="button" aria-label="关闭" onClick={onClose}>
            ×
          </button>
        </header>
        {!snapshot ? <p className="database-trash-loading">正在读取…</p> : null}
        {snapshot && !snapshot.rows.length ? (
          <p className="database-trash-loading">没有已归档记录。</p>
        ) : null}
        <div className="database-trash-list">
          {snapshot?.rows.map((row) => (
            <article key={row.id}>
              <div>
                <strong>{rowTitle(row, snapshot.properties)}</strong>
                <span>
                  {row.archivedAt ? new Date(row.archivedAt).toLocaleString() : '已归档'} · #
                  {row.sequenceNumber}
                </span>
              </div>
              <button
                type="button"
                disabled={Boolean(busyRowId)}
                onClick={() => void onRestore(row)}
              >
                <RotateCcw size={14} /> {busyRowId === row.id ? '恢复中…' : '恢复'}
              </button>
            </article>
          ))}
        </div>
      </section>
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
  const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
  const [templateDialogOpen, setTemplateDialogOpen] = useState(false);
  const [automationDialogOpen, setAutomationDialogOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [archivedSnapshot, setArchivedSnapshot] = useState<DatabaseSnapshot | null>(null);
  const [restoringRowId, setRestoringRowId] = useState<string | null>(null);
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

  const addRow = async (templateId?: string | null) => {
    const selectedTemplateId =
      templateId === undefined
        ? snapshot.templates.find((template) => template.isDefault)?.id
        : templateId;
    if (selectedTemplateId) {
      if (!editable || busy) return;
      setBusy(true);
      setError(null);
      try {
        const { row } = await createDatabaseRowFromTemplate(
          snapshot.database.id,
          selectedTemplateId,
        );
        if (row) setSnapshot((current) => ({ ...current, rows: [...current.rows, row] }));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '无法从模板新建记录');
      } finally {
        setBusy(false);
      }
      return;
    }
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

  const duplicateRow = async (row: DatabaseRowSummary) => {
    if (!editable || busy) return;
    setBusy(true);
    try {
      const { row: duplicate } = await duplicateDatabaseRow(snapshot.database.id, row.id);
      setSnapshot((current) => ({ ...current, rows: [...current.rows, duplicate] }));
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法复制记录');
    } finally {
      setBusy(false);
    }
  };

  const runButton = async (row: DatabaseRowSummary, property: DatabasePropertySummary) => {
    if (!editable) return;
    setError(null);
    try {
      const result = await executeDatabaseButton(snapshot.database.id, row.id, property.id);
      if (result.openUrl) {
        window.open(result.openUrl, '_blank', 'noopener,noreferrer');
      } else if (result.archived) {
        setSnapshot((current) => ({
          ...current,
          rows: current.rows.filter((candidate) => candidate.id !== row.id),
        }));
      } else if (result.row) {
        if (property.config.action === 'duplicate_row') {
          setSnapshot((current) => ({ ...current, rows: [...current.rows, result.row!] }));
        } else {
          setSnapshot((current) => ({
            ...current,
            rows: current.rows.map((candidate) =>
              candidate.id === row.id ? result.row! : candidate,
            ),
          }));
        }
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '按钮执行失败');
      throw reason;
    }
  };

  const openTrash = async () => {
    setTrashOpen(true);
    setArchivedSnapshot(null);
    try {
      setArchivedSnapshot(await getArchivedDatabaseRows(snapshot.database.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取已归档记录');
    }
  };

  const restoreRow = async (row: DatabaseRowSummary) => {
    if (!editable || restoringRowId) return;
    setRestoringRowId(row.id);
    try {
      const result = await updateDatabaseRow(snapshot.database.id, row.id, {
        values: {},
        archived: false,
      });
      if (result.row) {
        setSnapshot((current) => ({ ...current, rows: [...current.rows, result.row!] }));
        setArchivedSnapshot((current) =>
          current
            ? { ...current, rows: current.rows.filter((candidate) => candidate.id !== row.id) }
            : current,
        );
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法恢复记录');
    } finally {
      setRestoringRowId(null);
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
    allProperties: snapshot.properties,
    view: activeView,
    canEdit: editable,
    saveCell,
    addRow: () => void addRow(),
    createRow,
    removeRow: (row) => void removeRow(row),
    duplicateRow: (row) => void duplicateRow(row),
    executeButton: runButton,
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
          {editable ? (
            <div className="database-new-split">
              <button type="button" disabled={busy} onClick={() => void addRow()}>
                <Plus size={14} /> 新建
              </button>
              <button
                type="button"
                aria-label="选择数据库模板"
                aria-expanded={templateMenuOpen}
                onClick={() => setTemplateMenuOpen((open) => !open)}
              >
                <ChevronDown size={13} />
              </button>
              {templateMenuOpen ? (
                <div className="database-template-menu">
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateMenuOpen(false);
                      void addRow(null);
                    }}
                  >
                    <FileText size={14} /> 空白记录
                  </button>
                  {snapshot.templates.map((template) => (
                    <button
                      type="button"
                      key={template.id}
                      onClick={() => {
                        setTemplateMenuOpen(false);
                        void addRow(template.id);
                      }}
                    >
                      <LayoutTemplate size={14} />
                      <span>{template.name}</span>
                      {template.isDefault ? <small>默认</small> : null}
                    </button>
                  ))}
                  <hr />
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateMenuOpen(false);
                      setTemplateDialogOpen(true);
                    }}
                  >
                    <Settings2 size={14} /> 管理模板
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}
          {editable ? (
            <button type="button" title="已归档记录" onClick={() => void openTrash()}>
              <Archive size={14} />
            </button>
          ) : null}
          {editable ? (
            <button type="button" title="自动化" onClick={() => setAutomationDialogOpen(true)}>
              <Zap size={14} />
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
      {trashOpen ? (
        <DatabaseTrashDialog
          snapshot={archivedSnapshot}
          busyRowId={restoringRowId}
          onRestore={restoreRow}
          onClose={() => setTrashOpen(false)}
        />
      ) : null}
      {templateDialogOpen ? (
        <DatabaseTemplateDialog
          snapshot={snapshot}
          onChanged={refresh}
          onClose={() => setTemplateDialogOpen(false)}
        />
      ) : null}
      {automationDialogOpen ? (
        <DatabaseAutomationDialog
          snapshot={snapshot}
          onChanged={refresh}
          onClose={() => setAutomationDialogOpen(false)}
        />
      ) : null}
    </section>
  );
}

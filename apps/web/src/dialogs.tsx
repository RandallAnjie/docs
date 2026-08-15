import { FileText, Search } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';

import type { PageSearchResult, RecentPageResult } from '@rdocs/shared';

import { listRecentPages, searchPages } from './api';

export interface ConfirmDialogOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptDialogOptions {
  title: string;
  message?: string;
  label?: string;
  defaultValue?: string;
  placeholder?: string;
  submitLabel?: string;
  multiline?: boolean;
  allowEmpty?: boolean;
  validate?: (value: string) => string | null;
}

export interface NotifyDialogOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
}

export interface FormField {
  name: string;
  label: string;
  type?: 'select' | 'text' | 'textarea' | 'url';
  defaultValue?: string;
  placeholder?: string;
  options?: ReadonlyArray<{ label: string; value: string }>;
  required?: boolean;
  hint?: string;
  mono?: boolean;
}

export interface FormDialogOptions {
  title: string;
  message?: string;
  submitLabel?: string;
  fields: FormField[] | ((values: Record<string, string>) => FormField[]);
  validate?: (values: Record<string, string>) => string | null;
}

export interface PagePickOptions {
  organizationId: string;
  title?: string;
  message?: string;
}

export interface EmojiDialogOptions {
  title?: string;
  message?: string;
  defaultValue?: string;
  allowEmpty?: boolean;
}

export interface BookmarkDialogResult {
  title: string;
  url: string;
}

export interface PageButtonDialogResult {
  action: 'insertText' | 'insertTemplate' | 'openUrl';
  label: string;
  payload: string;
}

export interface PickedPage {
  id: string;
  title: string;
}

export type ToastTone = 'error' | 'info' | 'success';

interface ToastItem {
  id: string;
  message: string;
  tone: ToastTone;
}

type DialogRequest =
  | { kind: 'confirm'; options: ConfirmDialogOptions; resolve: (value: boolean) => void }
  | { kind: 'prompt'; options: PromptDialogOptions; resolve: (value: string | null) => void }
  | { kind: 'notify'; options: NotifyDialogOptions; resolve: () => void }
  | {
      kind: 'form';
      options: FormDialogOptions;
      resolve: (value: Record<string, string> | null) => void;
    }
  | { kind: 'page'; options: PagePickOptions; resolve: (value: PickedPage | null) => void }
  | { kind: 'emoji'; options: EmojiDialogOptions; resolve: (value: string | null) => void };

const listeners = new Set<() => void>();
const queue: DialogRequest[] = [];
let active: DialogRequest | null = null;
let toasts: ToastItem[] = [];

function emit() {
  for (const listener of listeners) listener();
}

function present(request: DialogRequest) {
  if (active) {
    queue.push(request);
    return;
  }
  active = request;
  emit();
}

function settle() {
  active = queue.shift() ?? null;
  emit();
}

function snapshot() {
  return { active, toasts };
}

export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
  return new Promise((resolve) => present({ kind: 'confirm', options, resolve }));
}

export function promptDialog(options: PromptDialogOptions): Promise<string | null> {
  return new Promise((resolve) => present({ kind: 'prompt', options, resolve }));
}

export function notifyDialog(options: NotifyDialogOptions): Promise<void> {
  return new Promise((resolve) => present({ kind: 'notify', options, resolve }));
}

export function formDialog(options: FormDialogOptions): Promise<Record<string, string> | null> {
  return new Promise((resolve) => present({ kind: 'form', options, resolve }));
}

export function pickPageDialog(options: PagePickOptions): Promise<PickedPage | null> {
  return new Promise((resolve) => present({ kind: 'page', options, resolve }));
}

export function emojiDialog(options: EmojiDialogOptions = {}): Promise<string | null> {
  return new Promise((resolve) => present({ kind: 'emoji', options, resolve }));
}

export function showToast(message: string, tone: ToastTone = 'error') {
  const id = crypto.randomUUID();
  toasts = [...toasts, { id, message, tone }];
  emit();
  window.setTimeout(() => dismissToast(id), 4200);
}

export function dismissToast(id: string) {
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export async function bookmarkDialog(options: {
  defaultTitle?: string;
  defaultUrl?: string;
  normalize: (value: string) => string | null;
}): Promise<BookmarkDialogResult | null> {
  const values = await formDialog({
    title: options.defaultUrl ? '编辑书签' : '添加书签',
    message: '粘贴一个网页地址，标题可留空，默认使用域名。',
    submitLabel: '保存书签',
    fields: [
      {
        name: 'url',
        label: '网址',
        type: 'url',
        defaultValue: options.defaultUrl ?? '',
        placeholder: 'https://',
        required: true,
      },
      {
        name: 'title',
        label: '标题',
        defaultValue: options.defaultTitle ?? '',
        placeholder: '可选，默认使用域名',
      },
    ],
    validate: (next) => (options.normalize(next.url ?? '') ? null : '请输入有效的 HTTP(S) 地址'),
  });
  if (!values) return null;
  const url = options.normalize(values.url ?? '');
  if (!url) return null;
  let title = (values.title ?? '').trim();
  if (!title) {
    try {
      title = new URL(url).hostname;
    } catch {
      title = url;
    }
  }
  return { title, url };
}

export async function embedDialog<T>(options: {
  defaultUrl?: string;
  normalize: (value: string) => T | null;
}): Promise<T | null> {
  const values = await formDialog({
    title: options.defaultUrl ? '编辑嵌入' : '嵌入内容',
    message: '支持 YouTube、Figma、Loom、CodePen、CodeSandbox 的 HTTPS 地址。',
    submitLabel: '嵌入',
    fields: [
      {
        name: 'url',
        label: '嵌入地址',
        type: 'url',
        defaultValue: options.defaultUrl ?? '',
        placeholder: 'https://',
        required: true,
      },
    ],
    validate: (next) =>
      options.normalize(next.url ?? '') ? null : '暂不支持这个嵌入地址，或地址不是 HTTPS',
  });
  return values ? options.normalize(values.url ?? '') : null;
}

export async function pageButtonDialog(options: {
  defaultAction?: 'insertText' | 'insertTemplate' | 'openUrl';
  defaultLabel?: string;
  defaultPayload?: string;
  normalizeUrl: (value: string) => string | null;
}): Promise<PageButtonDialogResult | null> {
  const values = await formDialog({
    title: options.defaultLabel ? '编辑按钮' : '页面按钮',
    message: '点击后可以插入预设正文，或打开一个网页。',
    submitLabel: '保存按钮',
    fields: (current) => [
      {
        name: 'label',
        label: '按钮名称',
        defaultValue: options.defaultLabel ?? '插入新内容',
        placeholder: '插入新内容',
        required: true,
      },
      {
        name: 'action',
        label: '点击后',
        type: 'select',
        defaultValue: options.defaultAction ?? 'insertText',
        options: [
          { value: 'insertText', label: '插入预设内容' },
          { value: 'insertTemplate', label: '插入 Markdown 模板' },
          { value: 'openUrl', label: '打开网页' },
        ],
      },
      current.action === 'openUrl'
        ? {
            name: 'payload',
            label: '网页地址',
            type: 'url',
            defaultValue: options.defaultPayload ?? 'https://',
            placeholder: 'https://',
            required: true,
          }
        : {
            name: 'payload',
            label: current.action === 'insertTemplate' ? 'Markdown 模板' : '插入内容',
            type: 'textarea',
            defaultValue:
              options.defaultPayload ??
              (current.action === 'insertTemplate' ? '## 标题\n\n正文' : '新内容'),
            placeholder:
              current.action === 'insertTemplate' ? '支持标题、列表和粗体' : '换行会创建多个段落',
            required: true,
          },
    ],
    validate: (next) => {
      if (!(next.label ?? '').trim()) return '请输入按钮名称';
      if (next.action === 'openUrl' && !options.normalizeUrl(next.payload ?? '')) {
        return '请输入有效的 HTTP(S) 网页地址';
      }
      return null;
    },
  });
  if (!values) return null;
  return {
    action:
      values.action === 'openUrl'
        ? 'openUrl'
        : values.action === 'insertTemplate'
          ? 'insertTemplate'
          : 'insertText',
    label: (values.label ?? '').trim().slice(0, 100),
    payload: (values.payload ?? '').slice(0, 10_000),
  };
}

const COMMON_EMOJIS = [
  '📄',
  '📝',
  '📚',
  '💡',
  '✅',
  '⭐',
  '🎯',
  '🚀',
  '🏠',
  '📁',
  '🛠',
  '🧪',
  '📊',
  '🗂',
  '🔒',
  '❤️',
  '🧠',
  '📌',
  '🗓',
  '✨',
];

function resolveFields(
  spec: FormField[] | ((values: Record<string, string>) => FormField[]),
  values: Record<string, string>,
): FormField[] {
  return typeof spec === 'function' ? spec(values) : spec;
}

function AppDialogShell({
  title,
  message,
  children,
  wide,
  onCancel,
  onSubmit,
}: {
  title: string;
  message?: string;
  children: ReactNode;
  wide?: boolean;
  onCancel: () => void;
  onSubmit?: () => void;
}) {
  const dialogRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => {
    const node = dialogRef.current;
    const focusable = node?.querySelector<HTMLElement>(
      'input, textarea, select, button:not([disabled])',
    );
    focusable?.focus();
    const select = node?.querySelector<HTMLInputElement | HTMLTextAreaElement>(
      'input:not([type="hidden"]), textarea',
    );
    select?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onCancel]);

  return (
    <div
      className="dialog-backdrop app-dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <form
        ref={dialogRef}
        className={`rdocs-dialog app-dialog ${wide ? 'app-dialog-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.();
        }}
      >
        <h2 id="app-dialog-title">{title}</h2>
        {message ? <p>{message}</p> : null}
        {children}
      </form>
    </div>
  );
}

function ConfirmView({
  options,
  onResolve,
}: {
  options: ConfirmDialogOptions;
  onResolve: (value: boolean) => void;
}) {
  return (
    <AppDialogShell
      title={options.title}
      message={options.message}
      onCancel={() => onResolve(false)}
      onSubmit={() => onResolve(true)}
    >
      <div className="dialog-actions">
        <button type="button" onClick={() => onResolve(false)}>
          {options.cancelLabel ?? '取消'}
        </button>
        <button className={options.danger ? 'danger-button' : 'primary-button'} type="submit">
          {options.confirmLabel ?? '确定'}
        </button>
      </div>
    </AppDialogShell>
  );
}

function PromptView({
  options,
  onResolve,
}: {
  options: PromptDialogOptions;
  onResolve: (value: string | null) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? '');
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const next = value.trim();
    if (!options.allowEmpty && !next) {
      setError('请输入内容');
      return;
    }
    const invalid = options.validate?.(options.allowEmpty ? value : next);
    if (invalid) {
      setError(invalid);
      return;
    }
    onResolve(options.allowEmpty ? value : next);
  };

  return (
    <AppDialogShell
      title={options.title}
      message={options.message}
      onCancel={() => onResolve(null)}
      onSubmit={submit}
    >
      <label>
        {options.label ?? '内容'}
        {options.multiline ? (
          <textarea
            value={value}
            placeholder={options.placeholder}
            rows={4}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submit();
              }
            }}
          />
        ) : (
          <input
            value={value}
            placeholder={options.placeholder}
            onChange={(event) => {
              setValue(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        )}
      </label>
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" onClick={() => onResolve(null)}>
          取消
        </button>
        <button className="primary-button" type="submit">
          {options.submitLabel ?? '确定'}
        </button>
      </div>
    </AppDialogShell>
  );
}

function NotifyView({
  options,
  onResolve,
}: {
  options: NotifyDialogOptions;
  onResolve: () => void;
}) {
  return (
    <AppDialogShell
      title={options.title ?? '提示'}
      message={options.message}
      onCancel={onResolve}
      onSubmit={onResolve}
    >
      <div className="dialog-actions">
        <button className="primary-button" type="submit">
          {options.confirmLabel ?? '知道了'}
        </button>
      </div>
    </AppDialogShell>
  );
}

function seedFormValues(
  spec: FormField[] | ((values: Record<string, string>) => FormField[]),
): Record<string, string> {
  const values: Record<string, string> = {};
  for (let pass = 0; pass < 2; pass += 1) {
    for (const field of resolveFields(spec, values)) {
      if (values[field.name] === undefined) values[field.name] = field.defaultValue ?? '';
    }
  }
  return values;
}

function FormView({
  options,
  onResolve,
}: {
  options: FormDialogOptions;
  onResolve: (value: Record<string, string> | null) => void;
}) {
  const [values, setValues] = useState(() => seedFormValues(options.fields));
  const [error, setError] = useState<string | null>(null);
  const fields = resolveFields(options.fields, values);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const invalid = options.validate?.(values);
    if (invalid) {
      setError(invalid);
      return;
    }
    onResolve(values);
  };

  return (
    <AppDialogShell
      title={options.title}
      message={options.message}
      onCancel={() => onResolve(null)}
      onSubmit={() => submit()}
    >
      {fields.map((field) => (
        <label key={field.name}>
          {field.label}
          {field.type === 'select' ? (
            <select
              value={values[field.name] ?? field.defaultValue ?? ''}
              required={field.required}
              onChange={(event) => {
                setValues((current) => ({ ...current, [field.name]: event.target.value }));
                setError(null);
              }}
            >
              {(field.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : field.type === 'textarea' ? (
            <textarea
              className={field.mono ? 'app-dialog-mono' : undefined}
              value={values[field.name] ?? ''}
              placeholder={field.placeholder}
              required={field.required}
              rows={5}
              onChange={(event) => {
                setValues((current) => ({ ...current, [field.name]: event.target.value }));
                setError(null);
              }}
            />
          ) : (
            <input
              className={field.mono ? 'app-dialog-mono' : undefined}
              type="text"
              inputMode={field.type === 'url' ? 'url' : undefined}
              value={values[field.name] ?? ''}
              placeholder={field.placeholder}
              required={field.required}
              onChange={(event) => {
                setValues((current) => ({ ...current, [field.name]: event.target.value }));
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          )}
          {field.hint ? <small className="app-dialog-hint">{field.hint}</small> : null}
        </label>
      ))}
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" onClick={() => onResolve(null)}>
          取消
        </button>
        <button className="primary-button" type="submit">
          {options.submitLabel ?? '确定'}
        </button>
      </div>
    </AppDialogShell>
  );
}

function PagePickView({
  options,
  onResolve,
}: {
  options: PagePickOptions;
  onResolve: (value: PickedPage | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{ id: string; title: string; snippet?: string }>>(
    [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(
      () => {
        setBusy(true);
        setError(null);
        const request = query.trim()
          ? searchPages(options.organizationId, query.trim(), { titleOnly: true }).then((result) =>
              result.results.map((item: PageSearchResult) => ({
                id: item.page.id,
                title: item.page.title,
                snippet: item.snippet,
              })),
            )
          : listRecentPages(options.organizationId).then((result) =>
              result.pages.slice(0, 12).map((item: RecentPageResult) => ({
                id: item.page.id,
                title: item.page.title,
              })),
            );
        void request
          .then((next) => {
            if (cancelled) return;
            setResults(next);
            setActiveIndex(0);
          })
          .catch((reason) => {
            if (cancelled) return;
            setError(reason instanceof Error ? reason.message : '无法搜索页面');
            setResults([]);
          })
          .finally(() => {
            if (!cancelled) setBusy(false);
          });
      },
      query.trim() ? 160 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [options.organizationId, query]);

  const choose = (item: { id: string; title: string }) => onResolve(item);

  return (
    <AppDialogShell
      title={options.title ?? '链接到页面'}
      message={options.message ?? '搜索工作区里的页面，或从最近打开的页面里选择。'}
      wide
      onCancel={() => onResolve(null)}
    >
      <label className="app-page-pick-search">
        搜索页面
        <span>
          <Search size={14} />
          <input
            value={query}
            placeholder="输入页面标题"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex((current) => (results.length ? (current + 1) % results.length : 0));
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex((current) =>
                  results.length ? (current - 1 + results.length) % results.length : 0,
                );
              } else if (event.key === 'Enter') {
                event.preventDefault();
                const selected = results[activeIndex];
                if (selected) choose(selected);
              }
            }}
          />
        </span>
      </label>
      <div className="app-page-pick-list" role="listbox" aria-label="页面结果">
        {busy && !results.length ? <p className="app-page-pick-empty">正在查找…</p> : null}
        {!busy && !results.length ? (
          <p className="app-page-pick-empty">
            {query.trim() ? '没有找到可访问的页面' : '暂无最近页面'}
          </p>
        ) : null}
        {results.map((item, index) => (
          <button
            key={item.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? 'active' : undefined}
            onMouseEnter={() => setActiveIndex(index)}
            onClick={() => choose(item)}
          >
            <FileText size={15} />
            <span>
              <strong>{item.title || '无标题'}</strong>
              {item.snippet ? <small>{item.snippet}</small> : null}
            </span>
          </button>
        ))}
      </div>
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" onClick={() => onResolve(null)}>
          取消
        </button>
      </div>
    </AppDialogShell>
  );
}

function EmojiView({
  options,
  onResolve,
}: {
  options: EmojiDialogOptions;
  onResolve: (value: string | null) => void;
}) {
  const [value, setValue] = useState(options.defaultValue ?? '');

  const commit = (next: string) => {
    const icon = [...next.trim()].slice(0, 2).join('');
    if (!icon && !options.allowEmpty) return;
    onResolve(icon);
  };

  return (
    <AppDialogShell
      title={options.title ?? '选择图标'}
      message={options.message ?? '点选一个常用 Emoji，或自己输入。留空可移除图标。'}
      onCancel={() => onResolve(null)}
      onSubmit={() => commit(value)}
    >
      <div className="app-emoji-grid" role="listbox" aria-label="常用图标">
        {COMMON_EMOJIS.map((emoji) => (
          <button
            key={emoji}
            type="button"
            className={value === emoji ? 'active' : undefined}
            onClick={() => setValue(emoji)}
            onDoubleClick={() => commit(emoji)}
          >
            {emoji}
          </button>
        ))}
      </div>
      <label>
        自定义
        <input
          value={value}
          placeholder="📄"
          maxLength={8}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit(value);
            }
          }}
        />
      </label>
      <div className="dialog-actions">
        {options.allowEmpty ? (
          <button type="button" onClick={() => onResolve('')}>
            移除图标
          </button>
        ) : (
          <button type="button" onClick={() => onResolve(null)}>
            取消
          </button>
        )}
        <button className="primary-button" type="submit">
          应用
        </button>
      </div>
    </AppDialogShell>
  );
}

export function DialogHost() {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    const listener = () => setState(snapshot());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const request = state.active;
  const finish = <T,>(value: T) => {
    if (!request || active !== request) return;
    (request.resolve as (next: T) => void)(value);
    settle();
  };

  return (
    <>
      {request?.kind === 'confirm' ? (
        <ConfirmView options={request.options} onResolve={(value) => finish(value)} />
      ) : null}
      {request?.kind === 'prompt' ? (
        <PromptView options={request.options} onResolve={(value) => finish(value)} />
      ) : null}
      {request?.kind === 'notify' ? (
        <NotifyView options={request.options} onResolve={() => finish(undefined)} />
      ) : null}
      {request?.kind === 'form' ? (
        <FormView options={request.options} onResolve={(value) => finish(value)} />
      ) : null}
      {request?.kind === 'page' ? (
        <PagePickView options={request.options} onResolve={(value) => finish(value)} />
      ) : null}
      {request?.kind === 'emoji' ? (
        <EmojiView options={request.options} onResolve={(value) => finish(value)} />
      ) : null}
      {state.toasts.length ? (
        <div className="app-toast-stack" aria-live="polite">
          {state.toasts.map((toast) => (
            <p key={toast.id} className={`app-toast app-toast-${toast.tone}`} role="status">
              {toast.message}
              <button type="button" aria-label="关闭" onClick={() => dismissToast(toast.id)}>
                ×
              </button>
            </p>
          ))}
        </div>
      ) : null}
    </>
  );
}

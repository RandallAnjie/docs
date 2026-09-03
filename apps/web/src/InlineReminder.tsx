import { mergeAttributes, Node, nodeInputRule } from '@tiptap/core';
import type { NodeViewProps } from '@tiptap/react';
import { NodeViewWrapper, ReactNodeViewRenderer } from '@tiptap/react';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { CalendarClock, Check, Pencil, Trash2, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
} from 'react';
import { createPortal } from 'react-dom';

import type { AuthUserSummary } from '@rdocs/shared';

import {
  cancelPageReminder,
  cancelPageReminderSource,
  createPageReminder,
  listPageReminders,
  updatePageReminder,
} from './api';

export interface InlineReminderContext {
  actorId: string;
  canEdit: boolean;
  pageId: string;
  publicShareToken?: string;
}

interface InlineReminderOptions {
  getContext: () => InlineReminderContext | null;
}

const LEAD_OPTIONS = [
  { minutes: 0, label: '到点提醒' },
  { minutes: 5, label: '提前 5 分钟' },
  { minutes: 15, label: '提前 15 分钟' },
  { minutes: 30, label: '提前 30 分钟' },
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 1_440, label: '提前 1 天' },
] as const;

function localDateTimeValue(timestamp: number): string {
  const date = new Date(timestamp);
  return new Date(timestamp - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function reminderLabel(dueAt: number, recipientName: string): string {
  if (!dueAt) return '@提醒';
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime())) return '@提醒';
  return `@提醒 ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}${recipientName ? ` · ${recipientName}` : ''}`;
}

function InlineReminderNodeView(props: NodeViewProps) {
  const options = props.extension.options as InlineReminderOptions;
  const context = options.getContext();
  const actorId = context?.actorId ?? '';
  const pageId = context?.pageId ?? '';
  const publicShareToken = context?.publicShareToken;
  const sourceId = String(props.node.attrs.sourceId ?? '');
  const storedReminderId = String(props.node.attrs.reminderId ?? '');
  const createdBy = String(props.node.attrs.createdBy ?? '');
  const storedDueAt = Number(props.node.attrs.dueAt ?? 0);
  const [open, setOpen] = useState(!storedReminderId);
  const [recipients, setRecipients] = useState<AuthUserSummary[]>([]);
  const [recipientId, setRecipientId] = useState(String(props.node.attrs.recipientId ?? ''));
  const [message, setMessage] = useState(String(props.node.attrs.message ?? '查看这里'));
  const [dueLocal, setDueLocal] = useState(() =>
    localDateTimeValue(storedDueAt > Date.now() ? storedDueAt : Date.now() + 60 * 60_000),
  );
  const [leadMinutes, setLeadMinutes] = useState(() =>
    Math.max(
      0,
      Math.round(
        (Number(props.node.attrs.dueAt ?? 0) - Number(props.node.attrs.remindAt ?? 0)) / 60_000,
      ),
    ),
  );
  const [reminderId, setReminderId] = useState(storedReminderId);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!pageId || publicShareToken || (createdBy && createdBy !== actorId)) return;
    setLoading(true);
    try {
      const result = await listPageReminders(pageId);
      setRecipients(result.recipients);
      const existing = result.reminders.find(
        (reminder) => reminder.sourceType === 'inline' && reminder.sourceId === sourceId,
      );
      if (existing) {
        setReminderId(existing.id);
        setRecipientId(existing.recipient.id);
        setMessage(existing.message);
        setDueLocal(localDateTimeValue(existing.dueAt));
        setLeadMinutes(Math.max(0, Math.round((existing.dueAt - existing.remindAt) / 60_000)));
      } else {
        setReminderId('');
        setRecipientId((current) =>
          result.recipients.some((recipient) => recipient.id === current)
            ? current
            : (result.recipients.find((recipient) => recipient.id === actorId)?.id ??
              result.recipients[0]?.id ??
              ''),
        );
      }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取正文提醒');
    } finally {
      setLoading(false);
    }
  }, [actorId, createdBy, pageId, publicShareToken, sourceId]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      !context?.canEdit ||
      (createdBy && createdBy !== actorId) ||
      !sourceId ||
      !recipientId ||
      !message.trim()
    )
      return;
    const dueAt = new Date(dueLocal).getTime();
    if (!Number.isFinite(dueAt) || dueAt <= Date.now()) {
      setError('提醒时间必须晚于现在');
      return;
    }
    const remindAt = dueAt - leadMinutes * 60_000;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    setBusy(true);
    setError(null);
    try {
      const input = {
        recipientId,
        message: message.trim(),
        dueAt,
        remindAt,
        timezone,
        sourceType: 'inline' as const,
        sourceId,
      };
      const result = reminderId
        ? await updatePageReminder(reminderId, input)
        : await createPageReminder(pageId, input);
      const saved = result.reminders.find(
        (reminder) => reminder.sourceType === 'inline' && reminder.sourceId === sourceId,
      );
      if (!saved) throw new Error('提醒已保存，但无法读取最新状态');
      setReminderId(saved.id);
      props.updateAttributes({
        dueAt: saved.dueAt,
        createdBy: saved.createdBy,
        message: saved.message,
        recipientId: saved.recipient.id,
        recipientName: saved.recipient.displayName,
        remindAt: saved.remindAt,
        reminderId: saved.id,
        timezone: saved.timezone,
      });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存正文提醒');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!context?.canEdit || busy) return;
    setBusy(true);
    try {
      if (reminderId) await cancelPageReminder(reminderId);
      props.deleteNode();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法删除正文提醒');
      setBusy(false);
    }
  };

  const recipientName = String(props.node.attrs.recipientName ?? '');
  const displayDueAt = Number(props.node.attrs.dueAt ?? 0);
  const delivered = displayDueAt > 0 && displayDueAt <= Date.now();
  const chipRef = useRef<HTMLButtonElement>(null);
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPopoverPos(null);
      return;
    }
    const update = () => {
      const rect = chipRef.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(370, window.innerWidth - 24);
      setPopoverPos({
        top: rect.bottom + 7,
        left: Math.min(Math.max(12, rect.left), window.innerWidth - width - 12),
      });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  return (
    <NodeViewWrapper
      as="span"
      className={`rdocs-inline-reminder ${delivered ? 'delivered' : ''}`}
      contentEditable={false}
    >
      <button
        ref={chipRef}
        type="button"
        className="rdocs-inline-reminder-chip"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {delivered ? <Check size={13} /> : <CalendarClock size={13} />}
        {reminderLabel(displayDueAt, recipientName)}
      </button>
      {open && popoverPos
        ? createPortal(
            <form
              className="rdocs-inline-reminder-popover"
              style={
                {
                  '--reminder-top': `${popoverPos.top}px`,
                  '--reminder-left': `${popoverPos.left}px`,
                } as CSSProperties
              }
              onSubmit={(event) => void submit(event)}
            >
              <header>
                <span>
                  <strong>正文提醒</strong>
                  <small>提醒会随页面权限变化自动失效</small>
                </span>
                <button type="button" aria-label="关闭" onClick={() => setOpen(false)}>
                  <X size={14} />
                </button>
              </header>
              {context?.canEdit &&
              !context.publicShareToken &&
              (!createdBy || createdBy === context.actorId) ? (
                <>
                  <label>
                    提醒谁
                    <select
                      value={recipientId}
                      disabled={busy || loading}
                      onChange={(event) => setRecipientId(event.target.value)}
                    >
                      {recipients.map((recipient) => (
                        <option key={recipient.id} value={recipient.id}>
                          {recipient.displayName} {recipient.id === context.actorId ? '（我）' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    提醒内容
                    <input
                      value={message}
                      maxLength={500}
                      disabled={busy}
                      onChange={(event) => setMessage(event.target.value)}
                    />
                  </label>
                  <div className="rdocs-inline-reminder-time">
                    <label>
                      日期和时间
                      <input
                        type="datetime-local"
                        value={dueLocal}
                        min={localDateTimeValue(Date.now() + 60_000)}
                        disabled={busy}
                        onChange={(event) => setDueLocal(event.target.value)}
                      />
                    </label>
                    <label>
                      提前量
                      <select
                        value={leadMinutes}
                        disabled={busy}
                        onChange={(event) => setLeadMinutes(Number(event.target.value))}
                      >
                        {LEAD_OPTIONS.map((option) => (
                          <option key={option.minutes} value={option.minutes}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  {error ? <p role="alert">{error}</p> : null}
                  <footer>
                    <button
                      type="button"
                      className="danger"
                      disabled={busy}
                      onClick={() => void remove()}
                    >
                      <Trash2 size={13} /> 删除
                    </button>
                    <button
                      type="submit"
                      disabled={busy || loading || !recipientId || !message.trim()}
                    >
                      <Pencil size={13} /> {busy ? '保存中…' : reminderId ? '保存修改' : '创建提醒'}
                    </button>
                  </footer>
                </>
              ) : (
                <p>{delivered ? '提醒时间已到' : '此提醒为只读'}</p>
              )}
            </form>,
            document.body,
          )
        : null}
    </NodeViewWrapper>
  );
}

export const InlineReminder = Node.create<InlineReminderOptions>({
  name: 'inlineReminder',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions() {
    return { getContext: () => null };
  },
  addAttributes() {
    return {
      sourceId: { default: '' },
      reminderId: { default: '' },
      createdBy: { default: '' },
      message: { default: '查看这里' },
      dueAt: { default: 0 },
      remindAt: { default: 0 },
      timezone: { default: 'UTC' },
      recipientId: { default: '' },
      recipientName: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-rdocs-inline-reminder]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-due-at': String(node.attrs.dueAt ?? 0),
        'data-rdocs-inline-reminder': '',
        'data-reminder-id': String(node.attrs.reminderId ?? ''),
        'data-source-id': String(node.attrs.sourceId ?? ''),
      }),
      reminderLabel(Number(node.attrs.dueAt ?? 0), String(node.attrs.recipientName ?? '')),
    ];
  },
  addNodeView() {
    return ReactNodeViewRenderer(InlineReminderNodeView);
  },
  addInputRules() {
    return [
      nodeInputRule({
        find: /(?:^|\s)(@(?:remind|提醒))\s$/i,
        type: this.type,
        getAttributes: () => {
          const current = this.options.getContext();
          if (!current?.canEdit || current.publicShareToken) return false;
          return {
            sourceId: crypto.randomUUID(),
            createdBy: current?.actorId ?? '',
            recipientId: current?.actorId ?? '',
            message: '查看这里',
          };
        },
      }),
    ];
  },
  addProseMirrorPlugins() {
    const getContext = this.options.getContext;
    const sourceCounts = (document: ProseMirrorNode) => {
      const counts = new Map<string, number>();
      document.descendants((node) => {
        if (node.type.name !== this.name) return;
        const sourceId = String(node.attrs.sourceId ?? '');
        if (sourceId) counts.set(sourceId, (counts.get(sourceId) ?? 0) + 1);
      });
      return counts;
    };
    return [
      new Plugin({
        view: () => ({
          update: (view, previousState) => {
            if (previousState.doc.eq(view.state.doc)) return;
            const before = sourceCounts(previousState.doc);
            const after = sourceCounts(view.state.doc);
            const removed = [...before.keys()].filter((sourceId) => !after.has(sourceId));
            if (!removed.length) return;
            const context = getContext();
            if (!context?.canEdit || context.publicShareToken) return;
            for (const sourceId of removed) {
              void cancelPageReminderSource(context.pageId, 'inline', sourceId).catch(
                () => undefined,
              );
            }
          },
        }),
      }),
    ];
  },
});

export function inlineReminderExtension(
  getContext: () => InlineReminderContext | null = () => null,
) {
  return InlineReminder.configure({ getContext });
}

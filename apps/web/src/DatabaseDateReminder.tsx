import { CalendarClock, Check, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { AuthUserSummary, PageReminderSummary } from '@rdocs/shared';

import {
  cancelPageReminder,
  createPageReminder,
  listPageReminders,
  updatePageReminder,
} from './api';

const LEAD_OPTIONS = [
  { minutes: 0, label: '当天 09:00' },
  { minutes: 30, label: '提前 30 分钟' },
  { minutes: 60, label: '提前 1 小时' },
  { minutes: 1_440, label: '提前 1 天' },
  { minutes: 2_880, label: '提前 2 天' },
  { minutes: 10_080, label: '提前 1 周' },
] as const;

function dueAtForDate(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = new Date(`${value}T09:00:00`).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function DatabaseDateReminder({
  actorId,
  canEdit,
  dateValue,
  pageId,
  propertyName,
  sourceId,
}: {
  actorId: string;
  canEdit: boolean;
  dateValue: string;
  pageId: string;
  propertyName: string;
  sourceId: string;
}) {
  const [open, setOpen] = useState(false);
  const [recipients, setRecipients] = useState<AuthUserSummary[]>([]);
  const [recipientId, setRecipientId] = useState(actorId);
  const [leadMinutes, setLeadMinutes] = useState(0);
  const [reminder, setReminder] = useState<PageReminderSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dueAt = dueAtForDate(dateValue);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listPageReminders(pageId);
      const existing =
        result.reminders.find(
          (candidate) =>
            candidate.createdBy === actorId &&
            candidate.sourceType === 'database_date' &&
            candidate.sourceId === sourceId,
        ) ?? null;
      setReminder(existing);
      setRecipients(result.recipients);
      setRecipientId(
        existing?.recipient.id ??
          result.recipients.find((recipient) => recipient.id === actorId)?.id ??
          result.recipients[0]?.id ??
          '',
      );
      setLeadMinutes(
        existing ? Math.max(0, Math.round((existing.dueAt - existing.remindAt) / 60_000)) : 0,
      );
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取日期提醒');
    } finally {
      setLoading(false);
    }
  }, [actorId, pageId, sourceId]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || !dueAt || dueAt <= Date.now() || !recipientId) return;
    setBusy(true);
    setError(null);
    try {
      const input = {
        recipientId,
        message: `${propertyName}：${dateValue}`,
        dueAt,
        remindAt: dueAt - leadMinutes * 60_000,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
        sourceType: 'database_date' as const,
        sourceId,
      };
      const result = reminder
        ? await updatePageReminder(reminder.id, input)
        : await createPageReminder(pageId, input);
      const saved = result.reminders.find(
        (candidate) =>
          candidate.createdBy === actorId &&
          candidate.sourceType === 'database_date' &&
          candidate.sourceId === sourceId,
      );
      if (!saved) throw new Error('日期提醒已保存，但无法读取最新状态');
      setReminder(saved);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法保存日期提醒');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!reminder || busy) return;
    setBusy(true);
    setError(null);
    try {
      await cancelPageReminder(reminder.id);
      setReminder(null);
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法取消日期提醒');
    } finally {
      setBusy(false);
    }
  };

  if (!canEdit || !dateValue) return null;

  return (
    <span className="database-date-reminder">
      <button
        type="button"
        aria-label={reminder ? '修改日期提醒' : '添加日期提醒'}
        title={reminder ? '修改日期提醒' : '提醒'}
        className={reminder ? 'active' : ''}
        onClick={() => setOpen(true)}
      >
        {reminder ? <Check size={12} /> : <CalendarClock size={12} />}
      </button>
      {open ? (
        <div className="database-date-reminder-backdrop" role="presentation">
          <form className="database-date-reminder-dialog" onSubmit={(event) => void save(event)}>
            <header>
              <span>
                <strong>日期提醒</strong>
                <small>{propertyName} · 当天 09:00</small>
              </span>
              <button type="button" aria-label="关闭" onClick={() => setOpen(false)}>
                <X size={15} />
              </button>
            </header>
            <label>
              提醒谁
              <select
                value={recipientId}
                disabled={busy || loading}
                onChange={(event) => setRecipientId(event.target.value)}
              >
                {recipients.map((recipient) => (
                  <option key={recipient.id} value={recipient.id}>
                    {recipient.displayName} {recipient.id === actorId ? '（我）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              提醒时间
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
            {!dueAt || dueAt <= Date.now() ? (
              <p role="alert">请选择未来日期后再创建提醒。</p>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            <footer>
              {reminder ? (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void cancel()}
                >
                  <Trash2 size={13} /> 取消提醒
                </button>
              ) : (
                <span />
              )}
              <button
                type="submit"
                disabled={busy || loading || !recipientId || !dueAt || dueAt <= Date.now()}
              >
                <CalendarClock size={13} /> {busy ? '保存中…' : reminder ? '保存修改' : '创建提醒'}
              </button>
            </footer>
          </form>
        </div>
      ) : null}
    </span>
  );
}

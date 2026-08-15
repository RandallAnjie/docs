import { Check, Copy, Sparkles, X } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import type { AiJobKind, AiJobSummary } from '@rdocs/shared';

import { runPageAi } from './api';

export interface EditorAiRequest {
  from: number | null;
  to: number | null;
  selectionText: string;
}

const QUICK_ACTIONS: Array<{ kind: AiJobKind; label: string; prompt: string }> = [
  { kind: 'summarize', label: '总结', prompt: '用几条要点总结这一页' },
  { kind: 'write', label: '续写', prompt: '顺着当前页面语气继续往下写两三段' },
  { kind: 'rewrite', label: '改进写作', prompt: '让这段话更清楚、更简洁，保持原意' },
  { kind: 'ask', label: '解释', prompt: '用更直白的话解释这段内容' },
];

function failure(reason: unknown): string {
  return reason instanceof Error ? reason.message : 'AI 暂时不可用';
}

export function PageAiComposer({
  pageId,
  pageTitle,
  pageExcerpt,
  request,
  canEdit,
  onClose,
  onInsert,
  onReplace,
}: {
  pageId: string;
  pageTitle: string;
  pageExcerpt: string;
  request: EditorAiRequest;
  canEdit: boolean;
  onClose: () => void;
  onInsert: (text: string) => void;
  onReplace: (text: string) => void;
}) {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<AiJobKind>(request.selectionText ? 'rewrite' : 'ask');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [job, setJob] = useState<AiJobSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const run = async (nextKind: AiJobKind, nextPrompt: string) => {
    const trimmed = nextPrompt.trim();
    if (busy) return;
    if (!trimmed && nextKind !== 'summarize' && !request.selectionText) return;
    setBusy(true);
    setError(null);
    setKind(nextKind);
    try {
      const result = await runPageAi(pageId, {
        kind: nextKind,
        prompt: trimmed || (nextKind === 'summarize' ? '用几条要点总结这一页' : ''),
        selection: request.selectionText || undefined,
        pageExcerpt: pageExcerpt || undefined,
      });
      setJob(result.job);
      if (result.job.status !== 'succeeded' && result.job.errorMessage) {
        setError(result.job.errorMessage);
      }
    } catch (reason) {
      setError(failure(reason));
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(request.selectionText ? 'rewrite' : kind === 'rewrite' ? 'ask' : kind, prompt);
  };

  return (
    <section className="page-ai-composer" aria-label="询问 AI">
      <header>
        <span className="page-ai-mark">
          <Sparkles size={15} />
        </span>
        <div>
          <strong>询问 AI</strong>
          <small>{request.selectionText ? '基于选中文字' : `关于「${pageTitle}」`}</small>
        </div>
        <button type="button" className="icon-button subtle" aria-label="关闭" onClick={onClose}>
          <X size={16} />
        </button>
      </header>
      {request.selectionText ? (
        <blockquote className="page-ai-quote">{request.selectionText}</blockquote>
      ) : null}
      <div className="page-ai-chips">
        {QUICK_ACTIONS.filter((action) => action.kind !== 'rewrite' || request.selectionText).map(
          (action) => (
            <button
              key={action.kind}
              type="button"
              disabled={busy}
              onClick={() => {
                setPrompt(action.prompt);
                void run(action.kind, action.prompt);
              }}
            >
              {action.label}
            </button>
          ),
        )}
      </div>
      <form onSubmit={submit}>
        <textarea
          ref={inputRef}
          rows={2}
          value={prompt}
          disabled={busy}
          placeholder={
            request.selectionText ? '让 AI 改写或解释选中内容…' : '问这一页，或让 AI 帮你写…'
          }
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit(event);
            }
            if (event.key === 'Escape') onClose();
          }}
        />
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? '正在写…' : '发送'}
        </button>
      </form>
      {error ? (
        <p className="page-ai-error" role="alert">
          {error}
        </p>
      ) : null}
      {job?.resultText ? (
        <div className="page-ai-result">
          <div className="page-ai-result-body">{job.resultText}</div>
          <div className="page-ai-result-actions">
            {canEdit ? (
              <button
                type="button"
                className="primary-button"
                onClick={() => onInsert(job.resultText!)}
              >
                插入正文
              </button>
            ) : null}
            {canEdit && request.selectionText ? (
              <button type="button" onClick={() => onReplace(job.resultText!)}>
                替换选中
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(job.resultText ?? '');
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1400);
              }}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
        </div>
      ) : busy ? (
        <div className="page-ai-pending">
          <div className="loading-mark" />
          正在根据页面内容生成…
        </div>
      ) : null}
    </section>
  );
}

export function AiSelectionToolbar({
  left,
  top,
  onAsk,
}: {
  left: number;
  top: number;
  onAsk: () => void;
}) {
  return (
    <div className="ai-selection-toolbar" style={{ left, top }}>
      <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onAsk}>
        <Sparkles size={13} />
        询问 AI
      </button>
    </div>
  );
}

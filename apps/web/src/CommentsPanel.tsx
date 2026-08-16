import { CheckCircle2, MessageSquare, Quote, Reply, RotateCcw, Send } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import type { CommentThreadSummary } from '@rdocs/shared';

import {
  createCommentThread,
  listComments,
  replyToCommentThread,
  setCommentThreadResolved,
} from './api';
import { startVisibleInterval } from './visible-poll';

export function CommentsPanel({
  pageId,
  canComment,
  focusedThreadId,
  selection,
  clearQuote,
}: {
  pageId: string;
  canComment: boolean;
  focusedThreadId?: string | null;
  selection: { quotedText: string; anchorStart: string; anchorEnd: string } | null;
  clearQuote: () => void;
}) {
  const [threads, setThreads] = useState<CommentThreadSummary[]>([]);
  const [body, setBody] = useState('');
  const [replyThreadId, setReplyThreadId] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setThreads((await listComments(pageId)).threads);
        if (!silent) setError(null);
      } catch (reason) {
        if (!silent) setError(reason instanceof Error ? reason.message : '无法加载评论');
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [pageId],
  );

  useEffect(() => {
    void load();
    return startVisibleInterval(() => void load(true), 12_000);
  }, [load]);

  useEffect(() => {
    if (!focusedThreadId || !threads.some((thread) => thread.id === focusedThreadId)) return;
    const frame = window.requestAnimationFrame(() => {
      document
        .getElementById(`comment-thread-${focusedThreadId}`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusedThreadId, threads]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createCommentThread(pageId, {
        body,
        quotedText: selection?.quotedText,
        anchorStart: selection?.anchorStart,
        anchorEnd: selection?.anchorEnd,
      });
      setThreads(result.threads);
      setBody('');
      clearQuote();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法发表评论');
    } finally {
      setBusy(false);
    }
  };

  const reply = async (event: FormEvent, threadId: string) => {
    event.preventDefault();
    if (!replyBody.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await replyToCommentThread(threadId, replyBody);
      setThreads(result.threads);
      setReplyBody('');
      setReplyThreadId(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法回复评论');
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (thread: CommentThreadSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      setThreads((await setCommentThreadResolved(thread.id, thread.status !== 'resolved')).threads);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新评论状态');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="comments-panel">
      {canComment ? (
        <form className="comment-compose" onSubmit={(event) => void create(event)}>
          {selection ? (
            <div className="comment-quote">
              <Quote size={13} /> <span>{selection.quotedText}</span>
              <button type="button" onClick={clearQuote} aria-label="取消引用">
                ×
              </button>
            </div>
          ) : null}
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder={selection ? '评论选中内容…' : '发起页面评论…'}
            maxLength={5000}
            rows={3}
          />
          <div>
            <small>用 @邮箱 提及组织成员</small>
            <button type="submit" disabled={busy || !body.trim()}>
              <Send size={13} /> 发表
            </button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="comment-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="comment-heading">
        <span>评论</span>
        <b>{threads.filter((thread) => thread.status === 'open').length}</b>
      </div>
      {loading ? (
        <div className="comment-state">
          <span className="mini-spinner" /> 正在加载…
        </div>
      ) : threads.length ? (
        <div className="comment-threads">
          {threads.map((thread) => (
            <article
              id={`comment-thread-${thread.id}`}
              className={`${thread.status === 'resolved' ? 'resolved' : ''} ${thread.id === focusedThreadId ? 'focused' : ''}`}
              key={thread.id}
            >
              {thread.quotedText ? (
                <blockquote>
                  <Quote size={11} /> {thread.quotedText}
                </blockquote>
              ) : null}
              {thread.comments.map((comment) => (
                <div className="comment-item" key={comment.id}>
                  <span>{comment.author.displayName.slice(0, 1).toUpperCase()}</span>
                  <div>
                    <header>
                      <strong>{comment.author.displayName}</strong>
                      <time>{new Date(comment.createdAt).toLocaleString()}</time>
                    </header>
                    <p>{comment.body}</p>
                  </div>
                </div>
              ))}
              {canComment && replyThreadId === thread.id ? (
                <form className="comment-reply" onSubmit={(event) => void reply(event, thread.id)}>
                  <textarea
                    autoFocus
                    value={replyBody}
                    onChange={(event) => setReplyBody(event.target.value)}
                    rows={2}
                    maxLength={5000}
                    placeholder="写下回复…"
                  />
                  <div>
                    <button type="button" onClick={() => setReplyThreadId(null)}>
                      取消
                    </button>
                    <button type="submit" disabled={!replyBody.trim() || busy}>
                      回复
                    </button>
                  </div>
                </form>
              ) : null}
              {canComment ? (
                <footer>
                  <button
                    type="button"
                    onClick={() => {
                      setReplyThreadId(thread.id);
                      setReplyBody('');
                    }}
                  >
                    <Reply size={12} /> 回复
                  </button>
                  <button type="button" onClick={() => void resolve(thread)}>
                    {thread.status === 'resolved' ? (
                      <RotateCcw size={12} />
                    ) : (
                      <CheckCircle2 size={12} />
                    )}
                    {thread.status === 'resolved' ? '重新打开' : '解决'}
                  </button>
                </footer>
              ) : null}
            </article>
          ))}
        </div>
      ) : (
        <div className="comment-state">
          <MessageSquare size={20} />
          <span>还没有评论</span>
        </div>
      )}
    </div>
  );
}

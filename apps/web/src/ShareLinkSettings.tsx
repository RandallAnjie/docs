import { Check, Clipboard, Link2, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { ShareLinkSummary } from '@rdocs/shared';

import { createShareLink, listShareLinks, revokeShareLink } from './api';

export function ShareLinkSettings({ pageId }: { pageId: string }) {
  const [links, setLinks] = useState<ShareLinkSummary[]>([]);
  const [days, setDays] = useState('7');
  const [newUrl, setNewUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    listShareLinks(pageId)
      .then((result) => active && setLinks(result.links))
      .catch(
        (reason) =>
          active && setError(reason instanceof Error ? reason.message : '无法加载分享链接'),
      );
    return () => {
      active = false;
    };
  }, [pageId]);

  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await createShareLink(pageId, {
        role: 'viewer',
        expiresInDays: days === 'never' ? null : Number(days),
      });
      setLinks((current) => [result.link, ...current]);
      setNewUrl(`${window.location.origin}/s/${encodeURIComponent(result.token)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法创建分享链接');
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (link: ShareLinkSummary) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await revokeShareLink(link.id);
      setLinks((current) =>
        current.map((candidate) =>
          candidate.id === link.id ? { ...candidate, revokedAt: result.revokedAt } : candidate,
        ),
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法撤销分享链接');
    } finally {
      setBusy(false);
    }
  };

  const activeLinks = links.filter(
    (link) => !link.revokedAt && (link.expiresAt === null || link.expiresAt > Date.now()),
  );
  return (
    <section className="share-link-settings">
      <header>
        <div>
          <Link2 size={16} />
          <span>
            <strong>外部查看链接</strong>
            <small>无需登录，可随时撤销</small>
          </span>
        </div>
        <b>{activeLinks.length}</b>
      </header>
      <div className="share-link-create">
        <select value={days} onChange={(event) => setDays(event.target.value)}>
          <option value="7">7 天有效</option>
          <option value="30">30 天有效</option>
          <option value="90">90 天有效</option>
          <option value="never">永不过期</option>
        </select>
        <button type="button" onClick={() => void create()} disabled={busy}>
          <Plus size={14} /> 创建链接
        </button>
      </div>
      {newUrl ? (
        <div className="share-link-new">
          <code>{newUrl}</code>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(newUrl);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? <Check size={14} /> : <Clipboard size={14} />} {copied ? '已复制' : '复制'}
          </button>
        </div>
      ) : null}
      {activeLinks.length ? (
        <div className="share-link-list">
          {activeLinks.map((link) => (
            <div key={link.id}>
              <span>
                <Link2 size={14} />
              </span>
              <div>
                <strong>只读链接</strong>
                <small>
                  {link.expiresAt
                    ? `${new Date(link.expiresAt).toLocaleString()} 过期`
                    : '永不过期'}
                </small>
              </div>
              <button
                type="button"
                title="撤销链接"
                onClick={() => void revoke(link)}
                disabled={busy}
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {error ? (
        <p className="dialog-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

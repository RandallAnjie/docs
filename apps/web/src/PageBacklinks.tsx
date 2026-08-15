import { Link2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { PageBacklinkSummary } from '@rdocs/shared';

import { listPageBacklinks } from './api';

export function PageBacklinks({ pageId }: { pageId: string }) {
  const [backlinks, setBacklinks] = useState<PageBacklinkSummary[] | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    const load = () =>
      listPageBacklinks(pageId)
        .then((result) => {
          if (active) setBacklinks(result.backlinks);
        })
        .catch(() => {
          if (active) setBacklinks([]);
        });
    void load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, [pageId]);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);

  if (!backlinks?.length) return null;
  return (
    <div className="page-backlinks">
      <button type="button" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
        <Link2 size={13} /> {backlinks.length} 个反向链接
      </button>
      {open ? (
        <div className="page-backlinks-popover" role="dialog" aria-label="链接到当前页面的页面">
          <strong>链接到此页面</strong>
          {backlinks.map((backlink) => (
            <a key={backlink.page.id} href={`/p/${encodeURIComponent(backlink.page.id)}`}>
              <span>{backlink.page.icon || '📄'}</span>
              <span>
                <b>{backlink.page.title}</b>
                <small>{new Date(backlink.lastSeenAt).toLocaleString()}</small>
              </span>
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

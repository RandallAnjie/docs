import { MAX_REVISION_SNAPSHOT_BYTES } from '@rdocs/shared';

import { durableRooms } from './durable-rooms';
import type { Env } from './env';
import { rewriteYjsAttachmentReferences } from './markdown';
import { searchIndexText } from './search-projection';

const MAX_PAGE_COPY_ATTACHMENTS = 200;
const MAX_PAGE_COPY_ATTACHMENT_BYTES = 250 * 1024 * 1024;

interface AttachmentRow {
  id: string;
  r2_key: string;
  original_name: string;
  mime_type: string;
  byte_size: number;
  sha256: string;
}

interface PageAppearanceRow {
  icon: string | null;
  cover_attachment_id: string | null;
  font_style: 'sans' | 'serif' | 'mono';
  is_full_width: number;
  is_small_text: number;
}

export class PageContentCopyError extends Error {
  constructor(
    message: string,
    readonly status = 500,
  ) {
    super(message);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes)));
  return [...digest].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function documentRoom(env: Env, pageId: string, generation: number): DurableObjectStub {
  const rooms = durableRooms(env);
  return rooms.get(rooms.idFromName(`document:${pageId}:generation:${generation}`));
}

async function deleteCopiedObjects(env: Env, keys: readonly string[]): Promise<void> {
  await Promise.all(keys.map((key) => env.ATTACHMENTS.delete(key)));
}

export async function copyPageContent(
  env: Env,
  input: {
    organizationId: string;
    sourcePageId: string;
    sourceGeneration: number;
    targetPageId: string;
    actorId: string;
  },
): Promise<Map<string, string>> {
  const snapshotResponse = await documentRoom(
    env,
    input.sourcePageId,
    input.sourceGeneration,
  ).fetch('https://rdocs.internal/internal/export-snapshot', {
    method: 'POST',
    headers: { 'x-rdocs-actor-id': input.actorId },
  });
  if (!snapshotResponse.ok) throw new PageContentCopyError('无法读取源记录正文', 502);
  const sourceSnapshot = new Uint8Array(await snapshotResponse.arrayBuffer());
  if (sourceSnapshot.byteLength > MAX_REVISION_SNAPSHOT_BYTES) {
    throw new PageContentCopyError('源记录正文过大，无法复制', 413);
  }
  // Tests and legacy empty rooms can legitimately return an empty 204 response.
  if (sourceSnapshot.byteLength) {
    const sourceHash = await sha256Hex(sourceSnapshot);
    if (snapshotResponse.headers.get('x-rdocs-content-hash') !== sourceHash) {
      throw new PageContentCopyError('源记录正文校验失败');
    }
  }

  const sourceAttachments = (
    await env.DB.prepare(
      `SELECT id, r2_key, original_name, mime_type, byte_size, sha256
         FROM attachments
        WHERE organization_id = ? AND page_id = ? AND status = 'ready' AND deleted_at IS NULL
        ORDER BY created_at ASC, id ASC LIMIT ?`,
    )
      .bind(input.organizationId, input.sourcePageId, MAX_PAGE_COPY_ATTACHMENTS + 1)
      .all<AttachmentRow>()
  ).results;
  const attachmentBytes = sourceAttachments.reduce((total, row) => total + row.byte_size, 0);
  if (
    sourceAttachments.length > MAX_PAGE_COPY_ATTACHMENTS ||
    attachmentBytes > MAX_PAGE_COPY_ATTACHMENT_BYTES
  ) {
    throw new PageContentCopyError('记录附件过多或总大小超过 250 MB，无法创建完整副本', 413);
  }

  const attachmentIds = new Map<string, string>();
  const copiedKeys: string[] = [];
  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  try {
    for (const attachment of sourceAttachments) {
      const object = await env.ATTACHMENTS.get(attachment.r2_key);
      if (!object) throw new PageContentCopyError(`附件“${attachment.original_name}”已丢失`);
      const attachmentId = crypto.randomUUID();
      const r2Key = `organizations/${input.organizationId}/pages/${input.targetPageId}/attachments/${attachmentId}`;
      await env.ATTACHMENTS.put(r2Key, object.body, {
        httpMetadata: { contentType: attachment.mime_type },
        customMetadata: {
          pageId: input.targetPageId,
          originalName: attachment.original_name,
          sha256: attachment.sha256,
          copiedFrom: attachment.id,
        },
      });
      copiedKeys.push(r2Key);
      attachmentIds.set(attachment.id, attachmentId);
      statements.push(
        env.DB.prepare(
          `INSERT INTO attachments(
             id, organization_id, page_id, r2_key, original_name, mime_type,
             byte_size, sha256, status, created_by, created_at, deleted_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, NULL)`,
        ).bind(
          attachmentId,
          input.organizationId,
          input.targetPageId,
          r2Key,
          attachment.original_name,
          attachment.mime_type,
          attachment.byte_size,
          attachment.sha256,
          input.actorId,
          now,
        ),
      );
    }
  } catch (reason) {
    await deleteCopiedObjects(env, copiedKeys);
    throw reason;
  }

  const projection = await env.DB.prepare(
    'SELECT normalized_body FROM page_search_projection WHERE page_id = ?',
  )
    .bind(input.sourcePageId)
    .first<{ normalized_body: string }>();
  const appearance = await env.DB.prepare(
    `SELECT icon, cover_attachment_id, font_style, is_full_width, is_small_text
       FROM pages WHERE id = ?`,
  )
    .bind(input.sourcePageId)
    .first<PageAppearanceRow>();
  statements.push(
    env.DB.prepare(
      `UPDATE pages
          SET icon = ?, cover_attachment_id = ?, font_style = ?,
              is_full_width = ?, is_small_text = ?, updated_by = ?, updated_at = ?
        WHERE id = ?`,
    ).bind(
      appearance?.icon ?? null,
      appearance?.cover_attachment_id
        ? (attachmentIds.get(appearance.cover_attachment_id) ?? null)
        : null,
      appearance?.font_style ?? 'sans',
      appearance?.is_full_width ? 1 : 0,
      appearance?.is_small_text ? 1 : 0,
      input.actorId,
      now,
      input.targetPageId,
    ),
    env.DB.prepare(
      `UPDATE page_search_projection SET normalized_body = ?, updated_at = ? WHERE page_id = ?`,
    ).bind(projection?.normalized_body ?? '', now, input.targetPageId),
    env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(input.targetPageId),
    env.DB.prepare(
      `INSERT INTO page_search_fts(page_id, title, normalized_body)
       SELECT page_id, ?, ? FROM page_search_projection WHERE page_id = ?`,
    ).bind(
      searchIndexText(
        (
          await env.DB.prepare('SELECT title FROM pages WHERE id = ?')
            .bind(input.targetPageId)
            .first<{ title: string }>()
        )?.title ?? '',
      ),
      searchIndexText(projection?.normalized_body ?? ''),
      input.targetPageId,
    ),
  );
  try {
    await env.DB.batch(statements);
  } catch (reason) {
    await deleteCopiedObjects(env, copiedKeys);
    throw reason;
  }

  if (!sourceSnapshot.byteLength) return attachmentIds;
  const snapshot = rewriteYjsAttachmentReferences(sourceSnapshot, attachmentIds);
  const contentHash = await sha256Hex(snapshot);
  const initialized = await documentRoom(env, input.targetPageId, 1).fetch(
    'https://rdocs.internal/internal/initialize-generation',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-rdocs-page-id': input.targetPageId,
        'x-rdocs-generation': '1',
        'x-rdocs-revision-id': `copy_${input.targetPageId}`,
        'x-rdocs-content-hash': contentHash,
        'x-rdocs-actor-id': input.actorId,
      },
      body: toArrayBuffer(snapshot),
    },
  );
  if (!initialized.ok) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM attachments WHERE page_id = ?').bind(input.targetPageId),
      env.DB.prepare(
        `UPDATE page_search_projection SET normalized_body = '', updated_at = ? WHERE page_id = ?`,
      ).bind(Date.now(), input.targetPageId),
      env.DB.prepare('DELETE FROM page_search_fts WHERE page_id = ?').bind(input.targetPageId),
      env.DB.prepare(
        `INSERT INTO page_search_fts(page_id, title, normalized_body)
         SELECT page_id, title, '' FROM page_search_projection WHERE page_id = ?`,
      ).bind(input.targetPageId),
    ]);
    await deleteCopiedObjects(env, copiedKeys);
    throw new PageContentCopyError('记录副本正文初始化失败');
  }
  return attachmentIds;
}

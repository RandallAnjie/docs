// Node's built-in sqlite typings are intentionally outside the Worker tsconfig.
// @ts-expect-error exercised by Vitest in Node.js 24
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import type { Env } from './env';
import { markdownToYjsSnapshot, yjsSnapshotToMarkdown } from './markdown';
import { copyPageContent } from './page-content-copy';

class TestStatement {
  constructor(
    private readonly statement: StatementSync,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.statement, values);
  }

  async first<T>(): Promise<T | null> {
    return (this.statement.get(...this.values) as T | undefined) ?? null;
  }

  async all<T>(): Promise<{ results: T[] }> {
    return { results: this.statement.all(...this.values) as T[] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: Number(this.statement.run(...this.values).changes) } };
  }
}

class TestD1 {
  constructor(readonly sqlite: DatabaseSync) {}

  prepare(sql: string): TestStatement {
    return new TestStatement(this.sqlite.prepare(sql));
  }

  async batch(statements: TestStatement[]): Promise<unknown[]> {
    this.sqlite.exec('BEGIN');
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (reason) {
      this.sqlite.exec('ROLLBACK');
      throw reason;
    }
  }
}

function bytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function hash(value: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', arrayBuffer(value)));
  return [...digest].map((part) => part.toString(16).padStart(2, '0')).join('');
}

describe('page content copy', () => {
  it('copies Yjs content and attachments while rewriting private attachment ids', async () => {
    const database = new DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE pages(id TEXT PRIMARY KEY, title TEXT NOT NULL);
      CREATE TABLE page_search_projection(
        page_id TEXT PRIMARY KEY, title TEXT NOT NULL, normalized_body TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE page_search_fts(page_id TEXT, title TEXT, normalized_body TEXT);
      CREATE TABLE attachments(
        id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, page_id TEXT NOT NULL,
        r2_key TEXT NOT NULL, original_name TEXT NOT NULL, mime_type TEXT NOT NULL,
        byte_size INTEGER NOT NULL, sha256 TEXT NOT NULL, status TEXT NOT NULL,
        created_by TEXT NOT NULL, created_at INTEGER NOT NULL, deleted_at INTEGER
      );
      INSERT INTO pages VALUES ('source-page', 'Source'), ('target-page', 'Source 副本');
      INSERT INTO page_search_projection VALUES ('source-page', 'Source', '正文索引', 1);
      INSERT INTO page_search_projection VALUES ('target-page', 'Source 副本', '', 1);
      INSERT INTO page_search_fts VALUES ('target-page', 'Source 副本', '');
    `);
    const sourceAttachmentId = '11111111-1111-4111-8111-111111111111';
    const sourceKey = 'source/key';
    database
      .prepare(
        `INSERT INTO attachments VALUES (?, 'org-1', 'source-page', ?, 'diagram.png',
          'image/png', 3, 'abc', 'ready', 'user-1', 1, NULL)`,
      )
      .run(sourceAttachmentId, sourceKey);
    const sourceSnapshot = markdownToYjsSnapshot(
      `# Copy me\n\n![diagram](/api/attachments/${sourceAttachmentId})`,
    ).snapshot;
    const rooms = new Map<string, Uint8Array>([
      ['document:source-page:generation:1', sourceSnapshot],
    ]);
    const objects = new Map<string, Uint8Array>([[sourceKey, new Uint8Array([1, 2, 3])]]);
    const d1 = new TestD1(database);
    const env = {
      DB: d1,
      ATTACHMENTS: {
        get: async (key: string) => {
          const body = objects.get(key);
          return body ? { body } : null;
        },
        put: async (key: string, value: ArrayBuffer | Uint8Array) => {
          objects.set(key, bytes(value));
        },
        delete: async (key: string) => {
          objects.delete(key);
        },
      },
      DocumentRoom: {
        idFromName: (name: string) => name,
        get: (name: string) => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith('/internal/export-snapshot')) {
              const snapshot = rooms.get(name) ?? new Uint8Array();
              return new Response(arrayBuffer(snapshot), {
                status: snapshot.byteLength ? 200 : 204,
                headers: snapshot.byteLength
                  ? { 'x-rdocs-content-hash': await hash(snapshot) }
                  : undefined,
              });
            }
            const snapshot = bytes(init?.body as ArrayBuffer);
            rooms.set(name, snapshot);
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;

    const attachmentIds = await copyPageContent(env, {
      organizationId: 'org-1',
      sourcePageId: 'source-page',
      sourceGeneration: 1,
      targetPageId: 'target-page',
      actorId: 'user-1',
    });

    const targetAttachmentId = attachmentIds.get(sourceAttachmentId);
    expect(targetAttachmentId).toBeTruthy();
    expect(targetAttachmentId).not.toBe(sourceAttachmentId);
    const copied = database
      .prepare('SELECT id, page_id, r2_key FROM attachments WHERE page_id = ?')
      .get('target-page') as { id: string; page_id: string; r2_key: string };
    expect(copied).toMatchObject({ id: targetAttachmentId, page_id: 'target-page' });
    expect(objects.get(copied.r2_key)).toEqual(new Uint8Array([1, 2, 3]));
    const targetSnapshot = rooms.get('document:target-page:generation:1');
    expect(targetSnapshot).toBeTruthy();
    const markdown = yjsSnapshotToMarkdown(targetSnapshot!, 'Source 副本');
    expect(markdown).toContain(`/api/attachments/${targetAttachmentId}`);
    expect(markdown).not.toContain(sourceAttachmentId);
    expect(
      database
        .prepare('SELECT normalized_body FROM page_search_projection WHERE page_id = ?')
        .get('target-page'),
    ).toMatchObject({ normalized_body: '正文索引' });
    database.close();
  });
});

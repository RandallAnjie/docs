import { durableRooms } from './durable-rooms';
import type { Env } from './env';

interface SyncedBlockRoomRow {
  id: string;
  current_generation: number;
}

function room(env: Env, block: SyncedBlockRoomRow): DurableObjectStub {
  const rooms = durableRooms(env);
  return rooms.get(
    rooms.idFromName(`synced-block:${block.id}:generation:${Number(block.current_generation)}`),
  );
}

function closeRooms(
  env: Env,
  blocks: readonly SyncedBlockRoomRow[],
  context: ExecutionContext,
): void {
  context.waitUntil(
    Promise.all(
      blocks.map((block) =>
        room(env, block).fetch('https://rdocs.internal/internal/access', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true, closeConnections: true }),
        }),
      ),
    ).then(() => undefined),
  );
}

export async function bumpSyncedBlocksForPageSubtree(
  env: Env,
  pageId: string,
  context: ExecutionContext,
): Promise<void> {
  const subtree = `WITH RECURSIVE subtree(id) AS (
    SELECT id FROM pages WHERE id = ?
    UNION ALL SELECT p.id FROM pages p JOIN subtree s ON p.parent_id = s.id
  )`;
  await env.DB.prepare(
    `${subtree}
     UPDATE synced_blocks SET acl_version = acl_version + 1, updated_at = ?
      WHERE deleted_at IS NULL AND (
        source_page_id IN (SELECT id FROM subtree)
        OR id IN (
          SELECT synced_block_id FROM synced_block_references
           WHERE page_id IN (SELECT id FROM subtree)
        )
      )`,
  )
    .bind(pageId, Date.now())
    .run();
  const blocks = (
    await env.DB.prepare(
      `${subtree}
       SELECT DISTINCT b.id, b.current_generation
         FROM synced_blocks b
         LEFT JOIN synced_block_references r ON r.synced_block_id = b.id
        WHERE b.deleted_at IS NULL
          AND (b.source_page_id IN (SELECT id FROM subtree)
               OR r.page_id IN (SELECT id FROM subtree))`,
    )
      .bind(pageId)
      .all<SyncedBlockRoomRow>()
  ).results;
  closeRooms(env, blocks, context);
}

export async function bumpSyncedBlocksForSpace(
  env: Env,
  spaceId: string,
  context: ExecutionContext,
): Promise<void> {
  const affected = `synced_blocks.source_page_id IN (
    SELECT id FROM pages WHERE space_id = ? AND deleted_at IS NULL
  ) OR synced_blocks.id IN (
    SELECT r.synced_block_id
      FROM synced_block_references r
      JOIN pages p ON p.id = r.page_id
     WHERE p.space_id = ? AND p.deleted_at IS NULL
  )`;
  await env.DB.prepare(
    `UPDATE synced_blocks
        SET acl_version = acl_version + 1, updated_at = ?
      WHERE synced_blocks.deleted_at IS NULL AND (${affected})`,
  )
    .bind(Date.now(), spaceId, spaceId)
    .run();
  const blocks = (
    await env.DB.prepare(
      `SELECT synced_blocks.id, synced_blocks.current_generation
         FROM synced_blocks
        WHERE synced_blocks.deleted_at IS NULL AND (${affected})`,
    )
      .bind(spaceId, spaceId)
      .all<SyncedBlockRoomRow>()
  ).results;
  closeRooms(env, blocks, context);
}

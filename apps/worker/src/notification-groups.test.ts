import { describe, expect, it } from 'vitest';

import type { NotificationSummary } from '@rdocs/shared';

import { groupNotifications } from './comments';

function notification(
  id: string,
  createdAt: number,
  input: Partial<NotificationSummary> = {},
): NotificationSummary {
  return {
    id,
    organizationId: 'org-1',
    actor: null,
    type: 'page_updated',
    pageId: 'page-1',
    pageTitle: 'Project',
    threadId: null,
    commentId: null,
    metadata: {},
    createdAt,
    readAt: null,
    archivedAt: null,
    ...input,
  };
}

describe('notification inbox grouping', () => {
  it('groups page updates separately from each comment thread', () => {
    const groups = groupNotifications([
      notification('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10),
      notification('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 30, {
        threadId: '11111111-1111-4111-8111-111111111111',
        type: 'comment_reply',
      }),
      notification('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 20, {
        threadId: '11111111-1111-4111-8111-111111111111',
        type: 'mention',
        readAt: 25,
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      latestAt: 30,
      threadId: '11111111-1111-4111-8111-111111111111',
      unreadCount: 1,
    });
    expect(groups[0]?.notifications.map((item) => item.createdAt)).toEqual([30, 20]);
    expect(groups[1]).toMatchObject({ threadId: null, unreadCount: 1 });
  });

  it('keeps organization-only notifications independently actionable', () => {
    const groups = groupNotifications([
      notification('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 10, { pageId: null }),
      notification('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 20, { pageId: null }),
    ]);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });
});

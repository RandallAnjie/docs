import { describe, expect, it } from 'vitest';

import { eventLabel } from './OrganizationActivity';

describe('organization activity labels', () => {
  it('uses the readable label for known events', () => {
    expect(eventLabel('page.content_updated')).toBe('编辑了页面内容');
    expect(eventLabel('database.row.created')).toBe('新增了数据库记录');
  });

  it('never shows a raw event type for unknown events', () => {
    expect(eventLabel('site.theme.updated')).toBe('更新了站点');
    expect(eventLabel('page.something_new')).toBe('操作了页面');
    expect(eventLabel('mystery.event')).toBe('执行了操作');
  });
});

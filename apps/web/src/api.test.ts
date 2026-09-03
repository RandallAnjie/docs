import { afterEach, describe, expect, it, vi } from 'vitest';

import { listPages } from './api';
import { clearCachedRequest } from './request-cache';

describe('page tree API', () => {
  afterEach(() => {
    clearCachedRequest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('retries one transient upstream failure for the idempotent tree read', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('upstream peer unreachable', { status: 502 }))
      .mockResolvedValueOnce(
        Response.json({
          pages: [
            {
              id: 'page_1',
              organizationId: 'org_1',
              spaceId: 'space_1',
              parentId: null,
              title: 'Recovered',
              currentGeneration: 1,
              editorSchemaVersion: 2,
              updatedAt: 1,
              collaborationEnabled: true,
              aclVersion: 1,
            },
          ],
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = listPages('space_1');
    await vi.advanceTimersByTimeAsync(150);
    await expect(resultPromise).resolves.toMatchObject({ pages: [{ id: 'page_1' }] });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent authorization response', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: '空间不存在或无权访问' }, { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(listPages('space_1')).rejects.toThrow('空间不存在或无权访问');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

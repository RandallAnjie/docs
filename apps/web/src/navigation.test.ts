import { describe, expect, it } from 'vitest';

import {
  commentThreadIdFromHash,
  pageIdFromPath,
  pagePath,
  resolveInAppNavigation,
  shouldInterceptInAppLink,
} from './navigation';

describe('page navigation helpers', () => {
  it('builds and parses page paths', () => {
    expect(pagePath('page_1')).toBe('/p/page_1');
    expect(pagePath('page_1', '#comment=thr_1')).toBe('/p/page_1#comment=thr_1');
    expect(pagePath('page/weird', 'comment=thr_1')).toBe('/p/page%2Fweird#comment=thr_1');
    expect(pageIdFromPath('/p/page_1')).toBe('page_1');
    expect(pageIdFromPath('/p/page%2Fweird/')).toBe('page/weird');
    expect(pageIdFromPath('/invite/abc')).toBeNull();
  });

  it('reads comment deep links from the hash', () => {
    expect(commentThreadIdFromHash('#comment=thr_9')).toBe('thr_9');
    expect(commentThreadIdFromHash('comment=thr_9&x=1')).toBe('thr_9');
    expect(commentThreadIdFromHash('#other=1')).toBeNull();
  });

  it('resolves same-origin page and home links only', () => {
    expect(resolveInAppNavigation('/p/page_1#comment=thr_1', 'https://docs.bigrandall.io')).toEqual(
      {
        type: 'page',
        pageId: 'page_1',
        hash: '#comment=thr_1',
      },
    );
    expect(resolveInAppNavigation('/', 'https://docs.bigrandall.io')).toEqual({ type: 'home' });
    expect(resolveInAppNavigation('/?settings=1', 'https://docs.bigrandall.io')).toBeNull();
    expect(
      resolveInAppNavigation('https://example.com/p/page_1', 'https://docs.bigrandall.io'),
    ).toBeNull();
  });

  it('keeps modified and new-tab clicks for the browser', () => {
    const base = {
      defaultPrevented: false,
      button: 0,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      target: null,
      download: false,
    };
    expect(shouldInterceptInAppLink(base)).toBe(true);
    expect(shouldInterceptInAppLink({ ...base, metaKey: true })).toBe(false);
    expect(shouldInterceptInAppLink({ ...base, button: 1 })).toBe(false);
    expect(shouldInterceptInAppLink({ ...base, target: '_blank' })).toBe(false);
    expect(shouldInterceptInAppLink({ ...base, download: true })).toBe(false);
  });
});

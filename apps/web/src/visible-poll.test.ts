import { describe, expect, it } from 'vitest';

import { startVisibleInterval } from './visible-poll';

describe('startVisibleInterval', () => {
  it('returns a stopper that can be called twice', () => {
    const stop = startVisibleInterval(() => undefined, 60_000);
    expect(() => {
      stop();
      stop();
    }).not.toThrow();
  });
});

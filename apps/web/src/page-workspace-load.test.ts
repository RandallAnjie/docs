import { describe, expect, it } from 'vitest';

import { waitWithBudget } from './page-workspace-load';

describe('waitWithBudget', () => {
  it('resolves true when the work finishes inside the budget', async () => {
    await expect(waitWithBudget(Promise.resolve(), 40)).resolves.toBe(true);
  });

  it('resolves false when the work is slower than the budget', async () => {
    await expect(
      waitWithBudget(new Promise((resolve) => globalThis.setTimeout(resolve, 60)), 15),
    ).resolves.toBe(false);
  });
});

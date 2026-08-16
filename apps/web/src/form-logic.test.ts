import { describe, expect, it } from 'vitest';

import { formFieldVisible } from './form-logic';

const field = (
  showIf: Record<string, unknown> | undefined,
): Parameters<typeof formFieldVisible>[0] => ({
  id: 'next',
  name: '下一题',
  type: 'text',
  required: false,
  config: showIf ? { showIf: showIf as never } : {},
});

describe('form conditionals', () => {
  it('hides a field until the controlling answer matches', () => {
    expect(
      formFieldVisible(field({ propertyId: 'kind', op: 'eq', value: '是' }), { kind: '否' }),
    ).toBe(false);
    expect(
      formFieldVisible(field({ propertyId: 'kind', op: 'eq', value: '是' }), { kind: '是' }),
    ).toBe(true);
  });
});

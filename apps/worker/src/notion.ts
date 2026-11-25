import type { AutomationValueContext, JsonValue } from '@rdocs/shared';

import type { Env } from './env';

/** Placeholder until the Notion connection is configured for an organization. */
export async function validateNotionCreatePage(
  _env: Env,
  _organizationId: string,
  _config: Record<string, JsonValue>,
): Promise<string | null> {
  return '尚未连接 Notion';
}

export async function runNotionCreatePage(
  _env: Env,
  _input: {
    organizationId: string;
    config: Record<string, JsonValue>;
    values: AutomationValueContext;
  },
): Promise<number | null> {
  throw new Error('尚未连接 Notion');
}

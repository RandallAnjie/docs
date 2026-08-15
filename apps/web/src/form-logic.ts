import type { JsonValue, PublicDatabaseFormField } from '@rdocs/shared';

export function formFieldVisible(
  field: PublicDatabaseFormField,
  values: Record<string, JsonValue>,
): boolean {
  const raw = field.config.showIf;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return true;
  const rule = raw as { op?: string; propertyId?: string; value?: JsonValue };
  if (!rule.propertyId) return true;
  const current = values[rule.propertyId];
  if (rule.op === 'is_empty')
    return current === null || current === undefined || current === '' || current === false;
  if (rule.op === 'not_empty')
    return !(current === null || current === undefined || current === '' || current === false);
  if (rule.op === 'neq') return JSON.stringify(current) !== JSON.stringify(rule.value ?? null);
  if (rule.op === 'contains') {
    return typeof current === 'string' && typeof rule.value === 'string'
      ? current.includes(rule.value)
      : Array.isArray(current) && current.includes(rule.value as never);
  }
  return JSON.stringify(current) === JSON.stringify(rule.value ?? null);
}

import type { DatabasePropertyType, JsonValue } from '@rdocs/shared';

export interface CellValueResult {
  ok: boolean;
  value: JsonValue;
  error: string | null;
}

const READ_ONLY_PROPERTY_TYPES = new Set<DatabasePropertyType>([
  'formula',
  'rollup',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
  'unique_id',
  'button',
]);

function accepted(value: JsonValue): CellValueResult {
  return { ok: true, value, error: null };
}

function rejected(error: string): CellValueResult {
  return { ok: false, value: null, error };
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === 'string' && value.length <= maximum ? value : null;
}

function stringList(value: unknown, maximum: number): string[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  const values = value.map((item) => text(item, 200));
  if (values.some((item) => item === null)) return null;
  return [...new Set(values as string[])];
}

function validDate(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 100) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function isComputedDatabaseProperty(type: DatabasePropertyType): boolean {
  return READ_ONLY_PROPERTY_TYPES.has(type);
}

export function normalizeDatabaseCellValue(
  type: DatabasePropertyType,
  value: unknown,
): CellValueResult {
  if (READ_ONLY_PROPERTY_TYPES.has(type)) return rejected('计算或系统属性不能直接写入');
  if (value === null) return accepted(null);

  switch (type) {
    case 'title':
    case 'text': {
      const normalized = text(value, type === 'title' ? 2_000 : 20_000);
      return normalized === null
        ? rejected('文本属性格式无效或超过长度上限')
        : accepted(normalized);
    }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? accepted(value)
        : rejected('数字属性必须是有限数字');
    case 'select':
    case 'status': {
      const normalized = text(value, 200);
      return normalized === null ? rejected('选项属性格式无效') : accepted(normalized);
    }
    case 'multi_select': {
      const normalized = stringList(value, 100);
      return normalized ? accepted(normalized) : rejected('多选属性格式无效');
    }
    case 'date': {
      if (typeof value === 'string') {
        const start = validDate(value);
        return start ? accepted({ start }) : rejected('日期格式无效');
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return rejected('日期属性格式无效');
      }
      const candidate = value as Record<string, unknown>;
      const start = validDate(candidate.start);
      const end =
        candidate.end === null || candidate.end === undefined ? null : validDate(candidate.end);
      if (!start || (candidate.end !== null && candidate.end !== undefined && !end)) {
        return rejected('日期起止时间无效');
      }
      const timezone = candidate.timezone === undefined ? null : text(candidate.timezone, 100);
      if (candidate.timezone !== undefined && timezone === null) return rejected('时区格式无效');
      return accepted({ start, end, timezone });
    }
    case 'relation':
    case 'person':
    case 'files': {
      const normalized = stringList(value, 100);
      return normalized ? accepted(normalized) : rejected('引用属性格式无效');
    }
    case 'checkbox':
      return typeof value === 'boolean' ? accepted(value) : rejected('复选框属性必须是布尔值');
    case 'url': {
      const normalized = text(value, 2_000);
      if (normalized === null) return rejected('URL 格式无效');
      try {
        const url = new URL(normalized);
        return url.protocol === 'http:' || url.protocol === 'https:'
          ? accepted(url.toString())
          : rejected('URL 仅支持 http 或 https');
      } catch {
        return rejected('URL 格式无效');
      }
    }
    case 'email': {
      const normalized = text(value, 254);
      return normalized && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
        ? accepted(normalized.toLowerCase())
        : rejected('邮箱格式无效');
    }
    case 'phone': {
      const normalized = text(value, 100);
      return normalized === null ? rejected('电话号码格式无效') : accepted(normalized);
    }
    case 'place': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return rejected('地点属性格式无效');
      }
      const candidate = value as Record<string, unknown>;
      const name = text(candidate.name, 500);
      const address = candidate.address === undefined ? null : text(candidate.address, 1_000);
      const latitude = candidate.latitude;
      const longitude = candidate.longitude;
      if (!name || (candidate.address !== undefined && address === null)) {
        return rejected('地点名称或地址无效');
      }
      if (
        typeof latitude !== 'number' ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        typeof longitude !== 'number' ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180
      ) {
        return rejected('地点坐标无效');
      }
      return accepted({ name, address, latitude, longitude });
    }
    default:
      return rejected('属性类型不支持直接写入');
  }
}

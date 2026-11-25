import { automationDisplayText, type DatabasePropertyType, type JsonValue } from '@rdocs/shared';

/** Shapes of the Notion API (version 2022-06-28) that the connector reads. */
export interface NotionRichText {
  plain_text?: string;
  href?: string | null;
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
}

export type NotionObject = Record<string, unknown>;

export interface NotionPropertySchema {
  name: string;
  type: string;
  options: string[];
}

export interface RdocsPropertyPlan {
  notionName: string;
  notionType: string;
  name: string;
  type: DatabasePropertyType;
  config: Record<string, JsonValue>;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function plainText(value: unknown): string {
  return list(value)
    .map((part) =>
      typeof record(part).plain_text === 'string' ? (record(part).plain_text as string) : '',
    )
    .join('');
}

/** Inline Markdown for Notion rich text (bold, italic, strikethrough, code, links). */
export function richTextMarkdown(value: unknown): string {
  return list(value)
    .map((part) => {
      const item = record(part) as NotionRichText;
      let text = item.plain_text ?? '';
      if (!text) return '';
      const marks = item.annotations ?? {};
      if (marks.code) text = `\`${text}\``;
      if (marks.bold) text = `**${text}**`;
      if (marks.italic) text = `*${text}*`;
      if (marks.strikethrough) text = `~~${text}~~`;
      if (item.href) text = `[${text}](${item.href})`;
      return text;
    })
    .join('');
}

export function notionTitle(object: NotionObject): string {
  if (Array.isArray(object.title)) return plainText(object.title).trim();
  for (const property of Object.values(record(object.properties))) {
    const value = record(property);
    if (value.type === 'title') return plainText(value.title).trim();
  }
  return '';
}

function optionNames(value: unknown): string[] {
  return list(record(value).options)
    .map((option) => record(option).name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

/** Property schema of a Notion database, title first. */
export function notionDatabaseSchema(database: NotionObject): NotionPropertySchema[] {
  const properties = Object.entries(record(database.properties)).map(([name, raw]) => {
    const value = record(raw);
    const type = typeof value.type === 'string' ? value.type : 'unknown';
    return { name, type, options: optionNames(value[type]) };
  });
  return properties.sort(
    (left, right) => Number(right.type === 'title') - Number(left.type === 'title'),
  );
}

const TYPE_MAP: Record<string, DatabasePropertyType> = {
  title: 'title',
  rich_text: 'text',
  number: 'number',
  select: 'select',
  status: 'status',
  multi_select: 'multi_select',
  date: 'date',
  checkbox: 'checkbox',
  url: 'url',
  email: 'email',
  phone_number: 'phone',
  created_time: 'date',
  last_edited_time: 'date',
  people: 'text',
  files: 'text',
  relation: 'text',
  formula: 'text',
  rollup: 'text',
  created_by: 'text',
  last_edited_by: 'text',
  unique_id: 'text',
};

/** How each Notion property becomes an Rdocs field; unsupported types are left out. */
export function planRdocsProperties(schema: readonly NotionPropertySchema[]): RdocsPropertyPlan[] {
  const used = new Set<string>();
  return schema.flatMap((property) => {
    const type = TYPE_MAP[property.type];
    if (!type) return [];
    let name = property.name.trim().slice(0, 100) || '字段';
    while (used.has(name)) name = `${name} 2`;
    used.add(name);
    const config: Record<string, JsonValue> =
      type === 'select' || type === 'status' || type === 'multi_select'
        ? { options: property.options.slice(0, 200) }
        : type === 'date' &&
            (property.type === 'created_time' || property.type === 'last_edited_time')
          ? { includeTime: true }
          : {};
    return [{ notionName: property.name, notionType: property.type, name, type, config }];
  });
}

function notionDate(value: unknown): JsonValue {
  const date = record(value);
  const start = typeof date.start === 'string' ? date.start : '';
  if (!start) return null;
  const end = typeof date.end === 'string' ? date.end : null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(start);
  const iso = (text: string) =>
    /^\d{4}-\d{2}-\d{2}$/.test(text) ? `${text}T00:00:00.000Z` : new Date(text).toISOString();
  if (!dateOnly && Number.isNaN(Date.parse(start))) return null;
  return { start: iso(start), end: end ? iso(end) : null, includeTime: !dateOnly };
}

function formulaText(value: unknown): string {
  const formula = record(value);
  const type = formula.type;
  if (type === 'string') return typeof formula.string === 'string' ? formula.string : '';
  if (type === 'number') return typeof formula.number === 'number' ? String(formula.number) : '';
  if (type === 'boolean')
    return formula.boolean === true ? '是' : formula.boolean === false ? '否' : '';
  if (type === 'date') return automationDisplayText(notionDate(formula.date));
  return '';
}

/** A Notion page property value as the Rdocs value for its planned field. */
export function notionValueToRdocs(raw: unknown): JsonValue {
  const value = record(raw);
  const type = typeof value.type === 'string' ? value.type : '';
  const data = value[type];
  switch (type) {
    case 'title':
    case 'rich_text':
      return plainText(data);
    case 'number':
      return typeof data === 'number' ? data : null;
    case 'select':
    case 'status':
      return typeof record(data).name === 'string' ? (record(data).name as string) : null;
    case 'multi_select':
      return list(data)
        .map((option) => record(option).name)
        .filter((name): name is string => typeof name === 'string');
    case 'date':
      return notionDate(data);
    case 'checkbox':
      return data === true;
    case 'url':
    case 'email':
    case 'phone_number':
      return typeof data === 'string' ? data : null;
    case 'created_time':
    case 'last_edited_time':
      return typeof data === 'string'
        ? { start: new Date(data).toISOString(), end: null, includeTime: true }
        : null;
    case 'people':
      return list(data)
        .map((person) => {
          const item = record(person);
          return typeof item.name === 'string'
            ? item.name
            : typeof record(item.person).email === 'string'
              ? (record(item.person).email as string)
              : '';
        })
        .filter(Boolean)
        .join('、');
    case 'created_by':
    case 'last_edited_by':
      return typeof record(data).name === 'string' ? (record(data).name as string) : '';
    case 'files':
      return list(data)
        .map((file) => {
          const item = record(file);
          return (record(item.external).url ?? record(item.file).url ?? item.name ?? '') as string;
        })
        .filter(Boolean)
        .join('\n');
    case 'relation':
      return list(data).length ? `${list(data).length} 条关联` : '';
    case 'formula':
      return formulaText(data);
    case 'rollup': {
      const rollup = record(data);
      if (rollup.type === 'number')
        return typeof rollup.number === 'number' ? String(rollup.number) : '';
      if (rollup.type === 'date') return automationDisplayText(notionDate(rollup.date));
      if (rollup.type === 'array') {
        return list(rollup.array)
          .map((item) => automationDisplayText(notionValueToRdocs(item)))
          .filter(Boolean)
          .join('、');
      }
      return '';
    }
    case 'unique_id': {
      const id = record(data);
      return typeof id.number === 'number'
        ? `${typeof id.prefix === 'string' && id.prefix ? `${id.prefix}-` : ''}${id.number}`
        : '';
    }
    default:
      return null;
  }
}

// ── Blocks → Markdown ─────────────────────────────────────────────────────

export interface NotionBlock extends NotionObject {
  type?: string;
  has_children?: boolean;
  children?: NotionBlock[];
}

function fileUrl(value: unknown): { url: string; hosted: boolean } {
  const item = record(value);
  const external = record(item.external).url;
  if (typeof external === 'string') return { url: external, hosted: false };
  const file = record(item.file).url;
  return typeof file === 'string' ? { url: file, hosted: true } : { url: '', hosted: false };
}

/**
 * Notion blocks as the Markdown the Rdocs importer reads. Files hosted by
 * Notion have expiring links, so they become a note with the link instead of
 * an embedded image.
 */
export function notionBlocksToMarkdown(blocks: readonly NotionBlock[], depth = 0): string {
  const lines: string[] = [];
  const indent = '  '.repeat(Math.min(depth, 4));
  let numbered = 0;
  const push = (line: string) => lines.push(line);
  for (const block of blocks) {
    const type = block.type ?? '';
    const data = record(block[type]);
    const text = richTextMarkdown(data.rich_text);
    if (type !== 'numbered_list_item') numbered = 0;
    switch (type) {
      case 'paragraph':
        push(depth ? `${indent}${text}` : text);
        if (!depth) push('');
        break;
      case 'heading_1':
      case 'heading_2':
      case 'heading_3':
        push(`${'#'.repeat(Number(type.slice(-1)) + 1)} ${text}`);
        push('');
        break;
      case 'bulleted_list_item':
        push(`${indent}- ${text}`);
        break;
      case 'numbered_list_item':
        numbered += 1;
        push(`${indent}${numbered}. ${text}`);
        break;
      case 'to_do':
        push(`${indent}- [${data.checked === true ? 'x' : ' '}] ${text}`);
        break;
      case 'toggle':
        push(`${indent}- ${text}`);
        break;
      case 'quote':
        push(`> ${text}`);
        push('');
        break;
      case 'callout': {
        const icon = record(data.icon);
        const emoji = typeof icon.emoji === 'string' ? icon.emoji : '💡';
        push(`> [!NOTE] ${emoji} ${text}`);
        push('');
        break;
      }
      case 'code': {
        const language =
          typeof data.language === 'string' && data.language !== 'plain text'
            ? data.language.replace(/\s+/g, '-')
            : '';
        push(`\`\`\`${language}`);
        push(plainText(data.rich_text));
        push('```');
        push('');
        break;
      }
      case 'divider':
        push('---');
        push('');
        break;
      case 'equation':
        push('$$');
        push(typeof data.expression === 'string' ? data.expression : '');
        push('$$');
        push('');
        break;
      case 'image': {
        const { url, hosted } = fileUrl(data);
        const caption = plainText(data.caption) || '图片';
        if (url && !hosted) push(`![${caption}](${url})`);
        else if (url) push(`[🖼 ${caption}（Notion 托管文件，请重新上传）](${url})`);
        push('');
        break;
      }
      case 'bookmark':
      case 'embed':
      case 'link_preview': {
        const url = typeof data.url === 'string' ? data.url : '';
        if (url) push(`[🔖 ${plainText(data.caption) || url}](${url})`);
        push('');
        break;
      }
      case 'video':
      case 'file':
      case 'pdf':
      case 'audio': {
        const { url } = fileUrl(data);
        if (url) push(`[📎 ${plainText(data.caption) || data.name || type}](${url})`);
        push('');
        break;
      }
      case 'child_page':
        push(`📄 ${typeof data.title === 'string' ? data.title : '子页面'}`);
        push('');
        break;
      case 'child_database':
        push(`🗂 ${typeof data.title === 'string' ? data.title : '子数据库'}（请单独导入）`);
        push('');
        break;
      case 'table': {
        const rows = (block.children ?? []).filter((row) => row.type === 'table_row');
        rows.forEach((row, index) => {
          const cells = list(record(row.table_row).cells).map((cell) =>
            richTextMarkdown(cell).replace(/\|/g, '\\|'),
          );
          push(`| ${cells.join(' | ')} |`);
          if (index === 0) push(`|${cells.map(() => ' --- ').join('|')}|`);
        });
        push('');
        break;
      }
      default:
        if (text) {
          push(text);
          push('');
        }
    }
    if (block.children?.length && type !== 'table') {
      const nested = notionBlocksToMarkdown(
        block.children,
        ['bulleted_list_item', 'numbered_list_item', 'to_do', 'toggle'].includes(type)
          ? depth + 1
          : depth,
      );
      if (nested.trim()) push(nested);
    }
  }
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

// ── Rdocs value → Notion property ─────────────────────────────────────────

function textOf(value: JsonValue | undefined): string {
  return automationDisplayText(value).slice(0, 2_000);
}

/**
 * The Notion property payload for a value, by the Notion property type. Returns
 * undefined when the type cannot be written (formulas, rollups, people, …).
 */
export function rdocsValueToNotion(notionType: string, value: JsonValue | undefined): unknown {
  switch (notionType) {
    case 'title':
    case 'rich_text': {
      const text = textOf(value);
      return { [notionType]: text ? [{ type: 'text', text: { content: text } }] : [] };
    }
    case 'number': {
      const number = typeof value === 'number' ? value : Number(textOf(value).replace(/,/g, ''));
      return { number: textOf(value) === '' || !Number.isFinite(number) ? null : number };
    }
    case 'select':
    case 'status': {
      const name = Array.isArray(value) ? textOf(value[0]) : textOf(value);
      return { [notionType]: name ? { name: name.replace(/,/g, ' ').slice(0, 100) } : null };
    }
    case 'multi_select': {
      const names = Array.isArray(value)
        ? value.map((item) => textOf(item))
        : textOf(value).split(/[,，、]/);
      return {
        multi_select: [
          ...new Set(
            names.map((name) => name.trim().replace(/,/g, ' ').slice(0, 100)).filter(Boolean),
          ),
        ].map((name) => ({ name })),
      };
    }
    case 'date': {
      const date = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
      const start =
        typeof date?.start === 'string' ? date.start : typeof value === 'string' ? value : '';
      if (!start || Number.isNaN(Date.parse(start))) return { date: null };
      const includeTime = date?.includeTime === true;
      const format = (iso: string) =>
        includeTime ? new Date(iso).toISOString() : iso.slice(0, 10);
      const end = typeof date?.end === 'string' && date.end ? format(date.end) : null;
      return { date: { start: format(start), ...(end ? { end } : {}) } };
    }
    case 'checkbox':
      return { checkbox: value === true || /^(true|是|yes|1)$/i.test(textOf(value)) };
    case 'url':
    case 'email':
    case 'phone_number': {
      const text = textOf(value);
      return { [notionType]: text || null };
    }
    default:
      return undefined;
  }
}

export const NOTION_WRITABLE_TYPES = new Set([
  'title',
  'rich_text',
  'number',
  'select',
  'status',
  'multi_select',
  'date',
  'checkbox',
  'url',
  'email',
  'phone_number',
]);

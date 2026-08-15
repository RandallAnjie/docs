import * as Y from 'yjs';

function xmlText(value: string): Y.XmlText {
  const text = new Y.XmlText();
  if (value) text.insert(0, value);
  return text;
}

function element(
  name: string,
  content: string,
  attributes: Record<string, string> = {},
): Y.XmlElement {
  const node = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (content) node.insert(0, [xmlText(content)]);
  return node;
}

function cleanInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1');
}

function decodeMarkdownComponent(value: string): string {
  try {
    return decodeURIComponent(value).slice(0, 10_000);
  } catch {
    return '';
  }
}

function markdownTableCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed
    .split(/(?<!\\)\|/)
    .map((cell) => cleanInlineMarkdown(cell.trim().replace(/\\\|/g, '|')));
}

export function markdownToYjsSnapshot(markdown: string): {
  snapshot: Uint8Array;
  title: string | null;
  plainText: string;
} {
  const document = new Y.Doc();
  const fragment = document.getXmlFragment('default');
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const nodes: Y.XmlElement[] = [];
  let title: string | null = null;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line.trim() === '$$') {
      const latex: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== '$$') {
        latex.push(lines[index] ?? '');
        index += 1;
      }
      nodes.push(element('blockMath', '', { latex: latex.join('\n').trim() }));
      index += 1;
      continue;
    }
    if (line.trim() === '<!-- rdocs:table-of-contents -->') {
      nodes.push(element('tableOfContents', ''));
      index += 1;
      continue;
    }
    if (line.trim() === '<!-- rdocs:breadcrumb -->') {
      nodes.push(element('breadcrumb', ''));
      index += 1;
      continue;
    }
    if (line.trim() === '<!-- rdocs:columns:start -->') {
      const columnBodies: string[][] = [];
      let currentColumn: string[] | null = null;
      index += 1;
      while (index < lines.length && (lines[index] ?? '').trim() !== '<!-- rdocs:columns:end -->') {
        if ((lines[index] ?? '').trim() === '<!-- rdocs:column -->') {
          currentColumn = [];
          columnBodies.push(currentColumn);
        } else if (currentColumn && (lines[index] ?? '').trim()) {
          currentColumn.push(lines[index] ?? '');
        }
        index += 1;
      }
      while (columnBodies.length < 2) columnBodies.push([]);
      const columns = new Y.XmlElement('columns');
      columnBodies.slice(0, 4).forEach((body) => {
        const column = new Y.XmlElement('column');
        column.insert(0, [element('paragraph', cleanInlineMarkdown(body.join(' ').trim()))]);
        columns.insert(columns.length, [column]);
      });
      nodes.push(columns);
      index += 1;
      continue;
    }
    if (line.trim() === '<details>') {
      const summaryLine = lines[index + 1] ?? '';
      const summary = summaryLine.match(/^<summary>(.*)<\/summary>$/)?.[1] ?? '折叠内容';
      index += summaryLine.startsWith('<summary>') ? 2 : 1;
      const body: string[] = [];
      while (index < lines.length && (lines[index] ?? '').trim() !== '</details>') {
        if ((lines[index] ?? '').trim()) body.push(lines[index] ?? '');
        index += 1;
      }
      const details = new Y.XmlElement('details');
      const detailsSummary = element('detailsSummary', cleanInlineMarkdown(summary));
      const detailsContent = new Y.XmlElement('detailsContent');
      detailsContent.insert(0, [element('paragraph', cleanInlineMarkdown(body.join(' ')))]);
      details.insert(0, [detailsSummary, detailsContent]);
      nodes.push(details);
      index += 1;
      continue;
    }
    const fence = line.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      const language = fence[1] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      nodes.push(element('codeBlock', code.join('\n'), language ? { language } : {}));
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const text = cleanInlineMarkdown(heading[2] ?? '');
      if (!title && heading[1]?.length === 1) title = text;
      nodes.push(element('heading', text, { level: String(heading[1]?.length ?? 1) }));
      index += 1;
      continue;
    }
    const nextLine = lines[index + 1] ?? '';
    if (line.includes('|') && /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(nextLine)) {
      const table = new Y.XmlElement('table');
      const tableLines = [line];
      index += 2;
      while (
        index < lines.length &&
        (lines[index] ?? '').includes('|') &&
        (lines[index] ?? '').trim()
      ) {
        tableLines.push(lines[index] ?? '');
        index += 1;
      }
      tableLines.forEach((tableLine, rowIndex) => {
        const row = new Y.XmlElement('tableRow');
        markdownTableCells(tableLine).forEach((cellText) => {
          const cell = new Y.XmlElement(rowIndex === 0 ? 'tableHeader' : 'tableCell');
          cell.insert(0, [element('paragraph', cellText)]);
          row.insert(row.length, [cell]);
        });
        table.insert(table.length, [row]);
      });
      nodes.push(table);
      continue;
    }
    const taskItem = line.match(/^\s*[-*+] \[([ xX])\]\s+(.*)$/);
    if (taskItem) {
      const list = new Y.XmlElement('taskList');
      while (index < lines.length) {
        const candidate = (lines[index] ?? '').match(/^\s*[-*+] \[([ xX])\]\s+(.*)$/);
        if (!candidate) break;
        const item = new Y.XmlElement('taskItem');
        item.setAttribute('checked', /x/i.test(candidate[1] ?? '') ? 'true' : 'false');
        item.insert(0, [element('paragraph', cleanInlineMarkdown(candidate[2] ?? ''))]);
        list.insert(list.length, [item]);
        index += 1;
      }
      nodes.push(list);
      continue;
    }
    const listItem = line.match(/^\s*([-*+] |\d+\. )(.*)$/);
    if (listItem) {
      const ordered = /\d+\. /.test(listItem[1] ?? '');
      const list = new Y.XmlElement(ordered ? 'orderedList' : 'bulletList');
      while (index < lines.length) {
        const candidate = (lines[index] ?? '').match(/^\s*([-*+] |\d+\. )(.*)$/);
        if (!candidate || /\d+\. /.test(candidate[1] ?? '') !== ordered) break;
        const item = new Y.XmlElement('listItem');
        item.insert(0, [element('paragraph', cleanInlineMarkdown(candidate[2] ?? ''))]);
        list.insert(list.length, [item]);
        index += 1;
      }
      nodes.push(list);
      continue;
    }
    const callout = line.match(/^>\s*\[!NOTE\]\s*(\S+)?\s*(.*)$/);
    if (callout) {
      const content = [callout[2] ?? ''];
      index += 1;
      while (index < lines.length) {
        const continuation = (lines[index] ?? '').match(/^>\s?(.*)$/);
        if (!continuation) break;
        content.push(continuation[1] ?? '');
        index += 1;
      }
      const calloutNode = new Y.XmlElement('callout');
      calloutNode.setAttribute('icon', callout[1] || '💡');
      calloutNode.setAttribute('tone', 'gray');
      calloutNode.insert(0, [element('paragraph', cleanInlineMarkdown(content.join(' ').trim()))]);
      nodes.push(calloutNode);
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      const blockquote = new Y.XmlElement('blockquote');
      blockquote.insert(0, [element('paragraph', cleanInlineMarkdown(quote[1] ?? ''))]);
      nodes.push(blockquote);
      index += 1;
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      nodes.push(element('horizontalRule', ''));
      index += 1;
      continue;
    }
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^\s)]+)(?:\s+["']([^"']*)["'])?\)$/);
    if (image) {
      nodes.push(
        element('image', '', {
          src: image[2] ?? '',
          alt: image[1] ?? '',
          ...(image[3] ? { title: image[3] } : {}),
        }),
      );
      index += 1;
      continue;
    }
    const bookmark = line.trim().match(/^\[🔖\s+([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/);
    if (bookmark) {
      nodes.push(
        element('bookmark', '', {
          title: cleanInlineMarkdown(bookmark[1] ?? ''),
          url: bookmark[2] ?? '',
        }),
      );
      index += 1;
      continue;
    }
    const embed = line.trim().match(/^\[▶\s+([^\]]+?)\s+嵌入\]\((https:\/\/[^\s)]+)\)$/);
    if (embed) {
      nodes.push(
        element('embed', '', {
          originalUrl: embed[2] ?? '',
          provider: embed[1] ?? '',
          src: '',
        }),
      );
      index += 1;
      continue;
    }
    const attachment = line
      .trim()
      .match(/^\[(📎|🎵|🎬)\s+((?:\\.|[^\\\]])+)\]\(\/api\/attachments\/([0-9a-f-]{36})\)$/i);
    if (attachment) {
      const kind = attachment[1] === '🎵' ? 'Audio' : attachment[1] === '🎬' ? 'Video' : 'File';
      nodes.push(
        element(`attachment${kind}`, '', {
          attachmentId: attachment[3] ?? '',
          byteSize: '0',
          mimeType:
            kind === 'Audio'
              ? 'audio/unknown'
              : kind === 'Video'
                ? 'video/unknown'
                : 'application/octet-stream',
          name: cleanInlineMarkdown(attachment[2] ?? '附件'),
        }),
      );
      index += 1;
      continue;
    }
    const pageButton = line
      .trim()
      .match(/^\[⚡\s+((?:\\.|[^\\\]])+)\]\(rdocs-button:(insertText|openUrl)\?payload=([^)]*)\)$/);
    if (pageButton) {
      nodes.push(
        element('pageButton', '', {
          action: pageButton[2] ?? 'insertText',
          label: cleanInlineMarkdown(pageButton[1] ?? '新按钮').slice(0, 100),
          payload: decodeMarkdownComponent(pageButton[3] ?? ''),
        }),
      );
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && (lines[index] ?? '').trim()) {
      const candidate = lines[index] ?? '';
      if (/^(#{1,6})\s+|^```|^\s*([-*+] |\d+\. )|^>/.test(candidate)) break;
      paragraph.push(candidate.trim());
      index += 1;
    }
    nodes.push(element('paragraph', cleanInlineMarkdown(paragraph.join(' '))));
  }
  if (!nodes.length) nodes.push(element('paragraph', ''));
  fragment.insert(0, nodes);
  const snapshot = Y.encodeStateAsUpdate(document);
  const plainText = nodes
    .map((node) => node.toString().replace(/<[^>]+>/g, ''))
    .join('\n')
    .trim();
  document.destroy();
  return { snapshot, title, plainText };
}

function inlineMarkdown(text: Y.XmlText): string {
  return text
    .toDelta()
    .map((part: { insert: unknown; attributes?: Record<string, unknown> }) => {
      let value = typeof part.insert === 'string' ? part.insert : '';
      const attributes = part.attributes ?? {};
      if (attributes.code) value = `\`${value}\``;
      if (attributes.bold) value = `**${value}**`;
      if (attributes.italic) value = `*${value}*`;
      if (attributes.strike) value = `~~${value}~~`;
      const href =
        typeof attributes.link === 'object' && attributes.link
          ? String((attributes.link as { href?: unknown }).href ?? '')
          : typeof attributes.link === 'string'
            ? attributes.link
            : '';
      if (href) value = `[${value}](${href})`;
      return value;
    })
    .join('');
}

function renderChildren(node: Y.XmlElement | Y.XmlFragment): string {
  return node
    .toArray()
    .map((child) => {
      if (child instanceof Y.XmlText) return inlineMarkdown(child);
      if (child instanceof Y.XmlElement) return renderElement(child);
      return '';
    })
    .join('');
}

function renderElement(node: Y.XmlElement): string {
  const content = renderChildren(node).trimEnd();
  switch (node.nodeName) {
    case 'heading':
      return `${'#'.repeat(Math.min(6, Math.max(1, Number(node.getAttribute('level')) || 1)))} ${content}\n\n`;
    case 'paragraph':
      return `${content}\n\n`;
    case 'blockquote':
      return `${content
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n\n`;
    case 'codeBlock':
      return `\`\`\`${node.getAttribute('language') ?? ''}\n${content}\n\`\`\`\n\n`;
    case 'horizontalRule':
      return '---\n\n';
    case 'image': {
      const src = node.getAttribute('src') ?? '';
      const alt = (node.getAttribute('alt') ?? '').replace(/]/g, '\\]');
      const title = node.getAttribute('title');
      return src ? `![${alt}](${src}${title ? ` "${title.replace(/"/g, '\\"')}"` : ''})\n\n` : '';
    }
    case 'callout': {
      const icon = node.getAttribute('icon') || '💡';
      const lines = content.trim().split('\n').filter(Boolean);
      return `${lines
        .map((line, index) => `> ${index === 0 ? `[!NOTE] ${icon} ` : ''}${line}`)
        .join('\n')}\n\n`;
    }
    case 'details': {
      const children = node
        .toArray()
        .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
      const summary = children.find((child) => child.nodeName === 'detailsSummary');
      const detailsContent = children.find((child) => child.nodeName === 'detailsContent');
      return `<details>\n<summary>${summary ? renderChildren(summary).trim() : '折叠内容'}</summary>\n\n${detailsContent ? renderChildren(detailsContent).trim() : ''}\n</details>\n\n`;
    }
    case 'bookmark': {
      const url = node.getAttribute('url') ?? '';
      const title = (node.getAttribute('title') || url).replace(/]/g, '\\]');
      return url ? `[🔖 ${title}](${url})\n\n` : '';
    }
    case 'embed': {
      const url = node.getAttribute('originalUrl') || node.getAttribute('src') || '';
      const provider = node.getAttribute('provider') || '网页';
      return url ? `[▶ ${provider} 嵌入](${url})\n\n` : '';
    }
    case 'attachmentFile':
    case 'attachmentAudio':
    case 'attachmentVideo': {
      const attachmentId = node.getAttribute('attachmentId') ?? '';
      const name = (node.getAttribute('name') || '附件')
        .replace(/\\/g, '\\\\')
        .replace(/]/g, '\\]');
      const icon =
        node.nodeName === 'attachmentAudio'
          ? '🎵'
          : node.nodeName === 'attachmentVideo'
            ? '🎬'
            : '📎';
      return attachmentId ? `[${icon} ${name}](/api/attachments/${attachmentId})\n\n` : '';
    }
    case 'tableOfContents':
      return '<!-- rdocs:table-of-contents -->\n\n';
    case 'breadcrumb':
      return '<!-- rdocs:breadcrumb -->\n\n';
    case 'pageButton': {
      const action = node.getAttribute('action') === 'openUrl' ? 'openUrl' : 'insertText';
      const label = (node.getAttribute('label') || '新按钮')
        .replace(/\\/g, '\\\\')
        .replace(/]/g, '\\]');
      const payload = encodeURIComponent(node.getAttribute('payload') || '');
      return `[⚡ ${label}](rdocs-button:${action}?payload=${payload})\n\n`;
    }
    case 'columns': {
      const columns = node
        .toArray()
        .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement)
        .map((column) => `<!-- rdocs:column -->\n${renderChildren(column).trim()}`)
        .join('\n\n');
      return `<!-- rdocs:columns:start -->\n${columns}\n<!-- rdocs:columns:end -->\n\n`;
    }
    case 'column':
      return content;
    case 'inlineMath': {
      const latex = node.getAttribute('latex') ?? '';
      return latex ? `$${latex}$` : '';
    }
    case 'blockMath': {
      const latex = node.getAttribute('latex') ?? '';
      return latex ? `$$\n${latex}\n$$\n\n` : '';
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = node.nodeName === 'orderedList';
      return `${node
        .toArray()
        .map((child, index) => {
          const item = child instanceof Y.XmlElement ? renderChildren(child).trim() : '';
          return `${ordered ? `${index + 1}.` : '-'} ${item.replace(/\n+/g, ' ')}`;
        })
        .join('\n')}\n\n`;
    }
    case 'taskList':
      return `${node
        .toArray()
        .map((child) => {
          if (!(child instanceof Y.XmlElement)) return '';
          const checked = child.getAttribute('checked');
          return `- [${checked === 'true' ? 'x' : ' '}] ${renderChildren(child).trim().replace(/\n+/g, ' ')}`;
        })
        .filter(Boolean)
        .join('\n')}\n\n`;
    case 'table': {
      const rows = node
        .toArray()
        .filter((child): child is Y.XmlElement => child instanceof Y.XmlElement);
      const rendered = rows.map((row) =>
        row
          .toArray()
          .map((cell) =>
            cell instanceof Y.XmlElement ? renderChildren(cell).trim().replace(/\|/g, '\\|') : '',
          )
          .map((cell) => ` ${cell} `)
          .join('|'),
      );
      if (!rendered.length) return '';
      const columnCount = rows[0]?.length ?? 1;
      rendered.splice(1, 0, Array.from({ length: columnCount }, () => ' --- ').join('|'));
      return `${rendered.map((row) => `|${row}|`).join('\n')}\n\n`;
    }
    case 'listItem':
    case 'taskItem':
      return content;
    case 'hardBreak':
      return '  \n';
    default:
      return content;
  }
}

export function yjsSnapshotToMarkdown(snapshot: Uint8Array, title?: string): string {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, snapshot);
    let shared: unknown;
    try {
      shared = document.getXmlFragment('default');
    } catch {
      shared = document.getText('default');
    }
    const body =
      shared instanceof Y.XmlFragment
        ? renderChildren(shared).trim()
        : shared instanceof Y.Text
          ? shared.toString().trim()
          : '';
    const normalizedTitle = title?.trim();
    if (!normalizedTitle) return `${body}\n`;
    if (body.startsWith(`# ${normalizedTitle}`)) return `${body}\n`;
    return `# ${normalizedTitle}\n\n${body}\n`;
  } finally {
    document.destroy();
  }
}

function replaceAttachmentUrls(value: unknown, replacements: ReadonlyMap<string, string>): unknown {
  if (typeof value === 'string') {
    const directReplacement = replacements.get(value);
    if (directReplacement) return directReplacement;
    return value.replace(
      /(\/api\/attachments\/)([0-9a-f-]{36})/gi,
      (match, prefix: string, attachmentId: string) => {
        const replacement = replacements.get(attachmentId);
        return replacement ? `${prefix}${replacement}` : match;
      },
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => replaceAttachmentUrls(item, replacements));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceAttachmentUrls(item, replacements)]),
    );
  }
  return value;
}

function rewriteSharedType(
  shared: Y.XmlElement | Y.XmlFragment | Y.XmlText,
  replacements: ReadonlyMap<string, string>,
): void {
  if (shared instanceof Y.XmlElement) {
    for (const [name, value] of Object.entries(shared.getAttributes())) {
      const next = replaceAttachmentUrls(value, replacements);
      if (typeof next === 'string' && next !== value) shared.setAttribute(name, next);
    }
  }
  if (shared instanceof Y.XmlText) {
    const current = shared.toDelta();
    const next = current.map((part: { insert: unknown; attributes?: Record<string, unknown> }) => ({
      ...part,
      ...(part.attributes
        ? { attributes: replaceAttachmentUrls(part.attributes, replacements) }
        : {}),
    }));
    if (JSON.stringify(current) !== JSON.stringify(next)) {
      shared.delete(0, shared.length);
      shared.applyDelta(next);
    }
    return;
  }
  for (const child of shared.toArray()) {
    if (child instanceof Y.XmlElement || child instanceof Y.XmlText) {
      rewriteSharedType(child, replacements);
    }
  }
}

export function rewriteYjsAttachmentReferences(
  snapshot: Uint8Array,
  replacements: ReadonlyMap<string, string>,
): Uint8Array {
  if (!replacements.size) return snapshot;
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, snapshot);
    rewriteSharedType(document.getXmlFragment('default'), replacements);
    return Y.encodeStateAsUpdate(document);
  } finally {
    document.destroy();
  }
}

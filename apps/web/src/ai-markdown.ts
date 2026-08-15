export interface EditorMark {
  attrs?: Record<string, unknown>;
  type: string;
}

export interface EditorInlineNode {
  marks?: EditorMark[];
  text: string;
  type: 'text';
}

export interface EditorBlockNode {
  attrs?: Record<string, unknown>;
  content?: Array<EditorBlockNode | EditorInlineNode>;
  type: string;
}

const INLINE_TOKEN =
  /`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)|\*\*(.+?)\*\*|__(.+?)__|(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|(?<!_)_(?!_)(.+?)(?<!_)_(?!_)|~~(.+?)~~/;

function unwrapMarkdownFence(source: string): string {
  const trimmed = source.replace(/^\uFEFF/, '').trim();
  const fenced = trimmed.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  return (fenced?.[1] ?? trimmed).replace(/\r\n?/g, '\n');
}

function paragraph(content: EditorInlineNode[]): EditorBlockNode {
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
}

function withMark(nodes: EditorInlineNode[], mark: EditorMark): EditorInlineNode[] {
  return nodes.map((node) => ({
    ...node,
    marks: [...(node.marks ?? []), mark],
  }));
}

export function parseInlineMarkdown(source: string): EditorInlineNode[] {
  const nodes: EditorInlineNode[] = [];
  let remaining = source;
  while (remaining) {
    const match = remaining.match(INLINE_TOKEN);
    if (!match || match.index === undefined) {
      nodes.push({ type: 'text', text: remaining });
      break;
    }
    if (match.index > 0) nodes.push({ type: 'text', text: remaining.slice(0, match.index) });
    if (match[1] !== undefined) {
      nodes.push({ type: 'text', text: match[1], marks: [{ type: 'code' }] });
    } else if (match[2] !== undefined) {
      nodes.push(
        ...withMark(parseInlineMarkdown(match[2]), {
          type: 'link',
          attrs: { href: match[3] ?? '', ...(match[4] ? { title: match[4] } : {}) },
        }),
      );
    } else if (match[5] !== undefined || match[6] !== undefined) {
      nodes.push(...withMark(parseInlineMarkdown(match[5] ?? match[6] ?? ''), { type: 'bold' }));
    } else if (match[7] !== undefined || match[8] !== undefined) {
      nodes.push(...withMark(parseInlineMarkdown(match[7] ?? match[8] ?? ''), { type: 'italic' }));
    } else if (match[9] !== undefined) {
      nodes.push(...withMark(parseInlineMarkdown(match[9]), { type: 'strike' }));
    }
    remaining = remaining.slice(match.index + match[0].length);
  }
  return nodes.filter((node) => node.text.length > 0);
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replace(/\\\|/g, '|'));
}

function consumeList(
  lines: string[],
  start: number,
  kind: 'bullet' | 'ordered' | 'task',
): { end: number; node: EditorBlockNode } {
  const items: EditorBlockNode[] = [];
  let index = start;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const task = line.match(/^\s*[-*+] \[([ xX])\]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (kind === 'task' && task) {
      items.push({
        type: 'taskItem',
        attrs: { checked: /x/i.test(task[1] ?? '') },
        content: [paragraph(parseInlineMarkdown(task[2] ?? ''))],
      });
    } else if (kind === 'ordered' && ordered && !task) {
      items.push({
        type: 'listItem',
        content: [paragraph(parseInlineMarkdown(ordered[1] ?? ''))],
      });
    } else if (kind === 'bullet' && bullet && !task) {
      items.push({
        type: 'listItem',
        content: [paragraph(parseInlineMarkdown(bullet[1] ?? ''))],
      });
    } else {
      break;
    }
    index += 1;
  }
  return {
    end: index,
    node: {
      type: kind === 'task' ? 'taskList' : kind === 'ordered' ? 'orderedList' : 'bulletList',
      content: items,
    },
  };
}

export function markdownToEditorContent(markdown: string): EditorBlockNode[] {
  const lines = unwrapMarkdownFence(markdown).split('\n');
  const nodes: EditorBlockNode[] = [];
  let index = 0;
  let paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (!paragraphLines.length) return;
    const text = paragraphLines.join(' ').trim();
    paragraphLines = [];
    if (text) nodes.push(paragraph(parseInlineMarkdown(text)));
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = trimmed.match(/^```\s*([\w+-]*)\s*$/);
    if (fence) {
      flushParagraph();
      const language = fence[1] ?? '';
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test((lines[index] ?? '').trim())) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      nodes.push({
        type: 'codeBlock',
        ...(language ? { attrs: { language } } : {}),
        content: code.length ? [{ type: 'text', text: code.join('\n') }] : undefined,
      });
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      nodes.push({
        type: 'heading',
        attrs: { level: heading[1]?.length ?? 1 },
        content: parseInlineMarkdown(heading[2] ?? ''),
      });
      index += 1;
      continue;
    }

    if (isTableSeparator(lines[index + 1] ?? '') && trimmed.includes('|')) {
      flushParagraph();
      const rows = [tableCells(line)];
      index += 2;
      while (
        index < lines.length &&
        (lines[index] ?? '').includes('|') &&
        (lines[index] ?? '').trim()
      ) {
        rows.push(tableCells(lines[index] ?? ''));
        index += 1;
      }
      nodes.push({
        type: 'table',
        content: rows.map((cells, rowIndex) => ({
          type: 'tableRow',
          content: cells.map((cell) => ({
            type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
            content: [paragraph(parseInlineMarkdown(cell))],
          })),
        })),
      });
      continue;
    }

    if (/^\s*[-*+] \[[ xX]\]\s+/.test(line)) {
      flushParagraph();
      const list = consumeList(lines, index, 'task');
      nodes.push(list.node);
      index = list.end;
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      flushParagraph();
      const list = consumeList(lines, index, 'ordered');
      nodes.push(list.node);
      index = list.end;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const list = consumeList(lines, index, 'bullet');
      nodes.push(list.node);
      index = list.end;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      const quotes: string[] = [quote[1] ?? ''];
      index += 1;
      while (index < lines.length) {
        const next = (lines[index] ?? '').match(/^>\s?(.*)$/);
        if (!next) break;
        quotes.push(next[1] ?? '');
        index += 1;
      }
      const paragraphs = quotes
        .join('\n')
        .split(/\n{2,}/)
        .map((part) => part.replace(/\n/g, ' ').trim())
        .filter(Boolean)
        .map((part) => paragraph(parseInlineMarkdown(part)));
      nodes.push({
        type: 'blockquote',
        content: paragraphs.length ? paragraphs : [{ type: 'paragraph' }],
      });
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      nodes.push({ type: 'horizontalRule' });
      index += 1;
      continue;
    }

    paragraphLines.push(trimmed);
    index += 1;
  }

  flushParagraph();
  return nodes.length ? nodes : [paragraph(parseInlineMarkdown(unwrapMarkdownFence(markdown)))];
}

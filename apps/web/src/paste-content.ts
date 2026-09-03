import type { Editor } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';

import { unwrapPhrasingWrappedBlocks } from '@rdocs/shared';

import { markdownToEditorContent, type EditorBlockNode } from './ai-markdown';
import { filesFromDataTransfer } from './page-upload';

export type ParsedPaste =
  | { kind: 'nodes'; content: EditorBlockNode[] }
  | { kind: 'html'; html: string }
  | { kind: 'default' };

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

export function extractClipboardHtmlFragment(html: string): string {
  const start = html.indexOf('<!--StartFragment-->');
  const end = html.indexOf('<!--EndFragment-->');
  if (start >= 0 && end > start) return html.slice(start + '<!--StartFragment-->'.length, end);
  const body = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] ?? html;
}

export function htmlHasRealTable(html: string): boolean {
  return /<table[\s>]/i.test(html);
}

function stripTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();
}

export function looksLikeStructuredMarkdown(text: string): boolean {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) return true;
  }
  if (lines.some((line) => /^#{1,6}\s+\S/.test(line.trim()))) return true;
  if (lines.some((line) => /^```/.test(line.trim()))) return true;
  if (lines.some((line) => /^>\s+\S/.test(line))) return true;
  const bullets = lines.filter(
    (line) => /^\s*[-*+]\s+\S/.test(line) && !/^\s*[-*+] \[[ xX]\]/.test(line),
  ).length;
  const ordered = lines.filter((line) => /^\s*\d+[.)]\s+\S/.test(line)).length;
  const tasks = lines.filter((line) => /^\s*[-*+] \[[ xX]\]\s+\S/.test(line)).length;
  return bullets >= 2 || ordered >= 2 || tasks >= 1;
}

export function looksLikeTsvTable(text: string): boolean {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0);
  if (lines.length < 2) return false;
  const counts = lines.map((line) => line.split('\t').length);
  const width = counts[0] ?? 0;
  return width >= 2 && counts.every((count) => count === width);
}

function htmlIsMarkdownSource(html: string): boolean {
  const trimmed = html.replace(/<!--[\s\S]*?-->/g, '').trim();
  if (!trimmed || htmlHasRealTable(trimmed)) return false;
  if (!/^<(pre|code|p)[\s>]/i.test(trimmed)) return false;
  return looksLikeStructuredMarkdown(stripTags(trimmed));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function cellText(html: string): string {
  return decodeEntities(
    html
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim(),
  );
}

function rowsToTable(rows: string[][]): EditorBlockNode {
  const width = Math.max(0, ...rows.map((row) => row.length));
  const padded = rows.map((row) => [
    ...row,
    ...Array.from({ length: width - row.length }, () => ''),
  ]);
  return {
    type: 'table',
    content: padded.map((cells, rowIndex) => ({
      type: 'tableRow',
      content: cells.map((cell) => ({
        type: rowIndex === 0 ? 'tableHeader' : 'tableCell',
        content: cell
          ? [{ type: 'paragraph', content: [{ type: 'text', text: cell }] }]
          : [{ type: 'paragraph' }],
      })),
    })),
  };
}

export function tsvToTableNode(text: string): EditorBlockNode {
  const rows = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => line.split('\t'));
  return rowsToTable(rows);
}

export function htmlTablesToNodes(html: string): EditorBlockNode[] {
  const tables: EditorBlockNode[] = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let match: RegExpExecArray | null;
  while ((match = tableRe.exec(html))) {
    const rows: string[][] = [];
    const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(match[0]))) {
      const cells: string[] = [];
      const cellRe = /<t[hd]\b[\s\S]*?<\/t[hd]>/gi;
      let cellMatch: RegExpExecArray | null;
      while ((cellMatch = cellRe.exec(rowMatch[0]))) cells.push(cellText(cellMatch[0]));
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rowsToTable(rows));
  }
  return tables;
}

function htmlIsMostlyTables(html: string): boolean {
  const withoutTables = html
    .replace(/<table\b[\s\S]*?<\/table>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  return stripTags(withoutTables).length < 8;
}

export function parsePastedClipboard(html: string, text: string): ParsedPaste {
  const plain = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const fragment = extractClipboardHtmlFragment(html);

  if (looksLikeStructuredMarkdown(plain) && (!fragment.trim() || htmlIsMarkdownSource(fragment))) {
    return { kind: 'nodes', content: markdownToEditorContent(plain) };
  }

  if (looksLikeTsvTable(plain) && !htmlHasRealTable(fragment)) {
    return { kind: 'nodes', content: [tsvToTableNode(plain)] };
  }

  if (htmlHasRealTable(fragment) && htmlIsMostlyTables(fragment)) {
    const tables = htmlTablesToNodes(fragment);
    if (tables.length) return { kind: 'nodes', content: tables };
  }

  if (fragment.trim()) {
    return { kind: 'html', html: unwrapPhrasingWrappedBlocks(fragment) };
  }

  if (looksLikeStructuredMarkdown(plain)) {
    return { kind: 'nodes', content: markdownToEditorContent(plain) };
  }

  return { kind: 'default' };
}

function selectionInTable(view: EditorView): boolean {
  const $from = view.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') return true;
  }
  return false;
}

export function handleRdocsPaste(
  editor: Editor | null,
  view: EditorView,
  event: ClipboardEvent,
  onFiles?: (files: File[]) => void,
): boolean {
  if (!editor?.isEditable) return false;
  const data = event.clipboardData;
  if (!data) return false;

  const html = data.getData('text/html') ?? '';
  const text = data.getData('text/plain') ?? '';
  const parsed = parsePastedClipboard(html, text);
  const files = filesFromDataTransfer(data);
  const inTable = selectionInTable(view);

  if (inTable) {
    if (files.length && !text.trim() && !html.trim()) {
      event.preventDefault();
      onFiles?.(files);
      return true;
    }
    return false;
  }

  if (parsed.kind === 'nodes' && parsed.content.length) {
    event.preventDefault();
    editor.chain().focus().insertContent(parsed.content).run();
    return true;
  }

  if (parsed.kind === 'html') {
    event.preventDefault();
    editor.chain().focus().insertContent(parsed.html).run();
    return true;
  }

  if (files.length) {
    event.preventDefault();
    onFiles?.(files);
    return true;
  }

  return false;
}

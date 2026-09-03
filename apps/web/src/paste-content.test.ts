import { describe, expect, it } from 'vitest';

import {
  extractClipboardHtmlFragment,
  htmlHasRealTable,
  htmlTablesToNodes,
  looksLikeStructuredMarkdown,
  looksLikeTsvTable,
  parsePastedClipboard,
  tsvToTableNode,
} from './paste-content';

describe('paste format detection', () => {
  it('recognizes GFM tables and lists as markdown', () => {
    expect(
      looksLikeStructuredMarkdown(['| 列 | 值 |', '| --- | --- |', '| A | 1 |'].join('\n')),
    ).toBe(true);
    expect(looksLikeStructuredMarkdown('# 标题\n\n正文')).toBe(true);
    expect(looksLikeStructuredMarkdown('- 一项\n- 二项')).toBe(true);
    expect(looksLikeStructuredMarkdown('普通一行')).toBe(false);
  });

  it('recognizes tab-separated tables from spreadsheets', () => {
    expect(looksLikeTsvTable('姓名\t分数\n张三\t90\n李四\t88')).toBe(true);
    expect(looksLikeTsvTable('hello world')).toBe(false);
  });
});

describe('parsePastedClipboard', () => {
  it('turns markdown tables into editor table nodes', () => {
    const parsed = parsePastedClipboard(
      '',
      ['| 城市 | 人口 |', '| --- | --- |', '| 上海 | 2487 |'].join('\n'),
    );
    expect(parsed.kind).toBe('nodes');
    if (parsed.kind !== 'nodes') return;
    expect(parsed.content[0]?.type).toBe('table');
    const headerRow = parsed.content[0]?.content?.[0];
    const bodyRow = parsed.content[0]?.content?.[1];
    expect(headerRow && 'content' in headerRow ? headerRow.content?.[0]?.type : null).toBe(
      'tableHeader',
    );
    expect(bodyRow && 'content' in bodyRow ? bodyRow.content?.[0]?.type : null).toBe('tableCell');
  });

  it('prefers markdown source wrapped in a pre over a rendered dump', () => {
    const markdown = ['## 小节', '', '- 一项', '- 二项'].join('\n');
    const parsed = parsePastedClipboard(`<pre>${markdown}</pre>`, markdown);
    expect(parsed.kind).toBe('nodes');
    if (parsed.kind !== 'nodes') return;
    expect(parsed.content.map((node) => node.type)).toEqual(['heading', 'bulletList']);
  });

  it('extracts Excel-style HTML fragments into a table', () => {
    const html = `<html><body><!--StartFragment--><table>
      <tr><td>A</td><td>B</td></tr>
      <tr><td>1</td><td>2</td></tr>
    </table><!--EndFragment--></body></html>`;
    expect(htmlHasRealTable(extractClipboardHtmlFragment(html))).toBe(true);
    const parsed = parsePastedClipboard(html, 'A\tB\n1\t2');
    expect(parsed.kind).toBe('nodes');
    if (parsed.kind !== 'nodes') return;
    expect(parsed.content).toEqual(htmlTablesToNodes(extractClipboardHtmlFragment(html)));
    const bodyRow = parsed.content[0]?.content?.[1];
    expect(bodyRow && 'content' in bodyRow ? bodyRow.content?.[1] : null).toMatchObject({
      type: 'tableCell',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '2' }] }],
    });
  });

  it('converts TSV when HTML is not a real table', () => {
    const parsed = parsePastedClipboard('<p>A\tB</p>', 'A\tB\n1\t2');
    expect(parsed.kind).toBe('nodes');
    if (parsed.kind !== 'nodes') return;
    expect(parsed.content).toEqual([tsvToTableNode('A\tB\n1\t2')]);
  });

  it('keeps ordinary HTML for the default editor parser', () => {
    const parsed = parsePastedClipboard('<p>你好 <strong>世界</strong></p>', '你好 世界');
    expect(parsed).toEqual({ kind: 'html', html: '<p>你好 <strong>世界</strong></p>' });
  });
});

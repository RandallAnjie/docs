import { describe, expect, it } from 'vitest';

import { markdownToFlowHtml, unwrapPhrasingWrappedBlocks } from './html-flow';

describe('unwrap phrasing-wrapped blocks', () => {
  it('lifts block tags out of span, strong, and paragraph wrappers', () => {
    expect(unwrapPhrasingWrappedBlocks('<span><div>块</div></span>')).toBe('<div>块</div>');
    expect(unwrapPhrasingWrappedBlocks('<p><h2>标题</h2></p>')).toBe('<h2>标题</h2>');
    expect(unwrapPhrasingWrappedBlocks('<p><ul><li>一项</li></ul></p>')).toBe(
      '<ul><li>一项</li></ul>',
    );
    expect(unwrapPhrasingWrappedBlocks('<strong><h1>大标题</h1></strong>')).toBe('<h1>大标题</h1>');
    expect(unwrapPhrasingWrappedBlocks('<span><li>一项</li></span>')).toBe('<li>一项</li>');
  });

  it('keeps phrasing marks on surrounding text when splitting', () => {
    expect(unwrapPhrasingWrappedBlocks('<span>前<div>中</div>后</span>')).toBe(
      '<span>前</span><div>中</div><span>后</span>',
    );
  });

  it('unwraps Word-style span wrappers around paragraphs', () => {
    expect(
      unwrapPhrasingWrappedBlocks(
        '<span style="font-size:12pt"><p class="MsoNormal">粘贴正文</p></span>',
      ),
    ).toBe('<p class="MsoNormal">粘贴正文</p>');
  });

  it('does not alter valid phrasing or sibling blocks', () => {
    expect(unwrapPhrasingWrappedBlocks('<p>你好 <strong>世界</strong></p>')).toBe(
      '<p>你好 <strong>世界</strong></p>',
    );
    expect(unwrapPhrasingWrappedBlocks('<div><p>合法</p></div>')).toBe('<div><p>合法</p></div>');
  });
});

describe('markdown to flow HTML', () => {
  it('emits headings and lists as siblings instead of wrapping them in p', () => {
    const html = markdownToFlowHtml('## 小节\n\n**粗体**\n\n- 一项');
    expect(html).toContain('<h2>小节</h2>');
    expect(html).toContain('<p><strong>粗体</strong></p>');
    expect(html).toContain('<ul><li>一项</li></ul>');
    expect(html).not.toMatch(/<p>\s*<h2/);
    expect(html).not.toMatch(/<p>\s*<ul/);
  });
});

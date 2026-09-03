const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hgroup',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'ul',
]);

const CANNOT_WRAP_BLOCKS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'font',
  'i',
  'kbd',
  'label',
  'mark',
  'p',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
]);

type HtmlNode =
  | { kind: 'text'; value: string }
  | {
      kind: 'element';
      name: string;
      attrs: string;
      children: HtmlNode[];
      selfClosing: boolean;
    };

function parseFragment(html: string): HtmlNode[] {
  const roots: HtmlNode[] = [];
  const stack: Array<{ name: string; attrs: string; children: HtmlNode[] }> = [];
  const current = (): HtmlNode[] => stack[stack.length - 1]?.children ?? roots;
  const tagRe = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)([^>]*?)(\/?)>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html))) {
    if (match.index > lastIndex) {
      current().push({ kind: 'text', value: html.slice(lastIndex, match.index) });
    }
    lastIndex = tagRe.lastIndex;
    if (match[0].startsWith('<!--')) continue;
    const name = (match[1] ?? '').toLowerCase();
    const closing = match[0].startsWith('</');
    const selfClosing = Boolean(match[3]) || VOID_TAGS.has(name);
    if (closing) {
      while (stack.length) {
        const open = stack.pop()!;
        const node: HtmlNode = {
          kind: 'element',
          name: open.name,
          attrs: open.attrs,
          children: open.children,
          selfClosing: false,
        };
        current().push(node);
        if (open.name === name) break;
      }
      continue;
    }
    if (selfClosing) {
      current().push({
        kind: 'element',
        name,
        attrs: match[2] ?? '',
        children: [],
        selfClosing: true,
      });
      continue;
    }
    stack.push({ name, attrs: match[2] ?? '', children: [] });
  }
  if (lastIndex < html.length) current().push({ kind: 'text', value: html.slice(lastIndex) });
  while (stack.length) {
    const open = stack.pop()!;
    current().push({
      kind: 'element',
      name: open.name,
      attrs: open.attrs,
      children: open.children,
      selfClosing: false,
    });
  }
  return roots;
}

function serialize(nodes: readonly HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === 'text') return node.value;
      if (node.selfClosing || VOID_TAGS.has(node.name)) return `<${node.name}${node.attrs}>`;
      return `<${node.name}${node.attrs}>${serialize(node.children)}</${node.name}>`;
    })
    .join('');
}

function isBlockElement(node: HtmlNode): boolean {
  return node.kind === 'element' && BLOCK_TAGS.has(node.name);
}

function liftBlocksOutOfPhrasing(nodes: HtmlNode[]): HtmlNode[] {
  const output: HtmlNode[] = [];
  for (const node of nodes) {
    if (node.kind === 'text') {
      output.push(node);
      continue;
    }
    const children = liftBlocksOutOfPhrasing(node.children);
    if (!CANNOT_WRAP_BLOCKS.has(node.name) || !children.some(isBlockElement)) {
      output.push({ ...node, children });
      continue;
    }
    let buffer: HtmlNode[] = [];
    const flushBuffer = () => {
      if (!buffer.length) return;
      output.push({ ...node, children: buffer, selfClosing: false });
      buffer = [];
    };
    for (const child of children) {
      if (isBlockElement(child)) {
        flushBuffer();
        output.push(child);
      } else {
        buffer.push(child);
      }
    }
    flushBuffer();
  }
  return output;
}

/** Split phrasing/`<p>` wrappers so they never contain block-level children. */
export function unwrapPhrasingWrappedBlocks(html: string): string {
  let nodes = parseFragment(html);
  for (let pass = 0; pass < 16; pass += 1) {
    const next = liftBlocksOutOfPhrasing(nodes);
    const serialized = serialize(next);
    if (serialized === serialize(nodes)) return serialized;
    nodes = next;
  }
  return serialize(nodes);
}

function escapeText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineMarkdown(value: string): string {
  return escapeText(value)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/** Convert a markdown string into a flow HTML fragment (no `<p>` wrapping headings/lists). */
export function markdownToFlowHtml(markdown: string): string {
  const blocks: string[] = [];
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let index = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${inlineMarkdown(paragraph.join('\n')).replace(/\n/g, '<br />')}</p>`);
    paragraph = [];
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading?.[1] && heading[2] !== undefined) {
      flushParagraph();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph();
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push(`<li>${inlineMarkdown((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''))}</li>`);
        index += 1;
      }
      blocks.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      index += 1;
      continue;
    }
    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return unwrapPhrasingWrappedBlocks(blocks.join(''));
}

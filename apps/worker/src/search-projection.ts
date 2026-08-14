import * as Y from 'yjs';

function sharedText(node: unknown): string {
  if (node instanceof Y.XmlText || node instanceof Y.Text) return node.toString();
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    const content = node.toArray().map(sharedText).join('');
    return node instanceof Y.XmlElement ? `${content}\n` : content;
  }
  return '';
}

export function documentPlainText(document: Y.Doc): string {
  let shared: unknown = document.share.get('default');
  if (!shared) {
    try {
      shared = document.getXmlFragment('default');
    } catch {
      shared = document.getText('default');
    }
  }
  return sharedText(shared)
    .normalize('NFKC')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

export function searchIndexText(value: string): string {
  const normalized = normalizeSearchText(value);
  const tokens = new Set<string>();
  for (const word of normalized.match(/[a-z0-9_]+/g) ?? []) tokens.add(word);
  for (const sequence of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const characters = [...sequence];
    for (const character of characters) tokens.add(character);
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= characters.length; index += 1) {
        tokens.add(characters.slice(index, index + size).join(''));
      }
    }
  }
  return [...tokens].join(' ');
}

export function ftsMatchQuery(value: string): string | null {
  const tokens = searchIndexText(value).split(' ').filter(Boolean).slice(0, 20);
  return tokens.length
    ? tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ')
    : null;
}

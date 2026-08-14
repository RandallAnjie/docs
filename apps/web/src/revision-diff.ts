import * as Y from 'yjs';

export interface RevisionDiffLine {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

function sharedNodeText(node: unknown): string {
  if (node instanceof Y.XmlText || node instanceof Y.Text) return node.toString();
  if (node instanceof Y.XmlElement || node instanceof Y.XmlFragment) {
    const content = node.toArray().map(sharedNodeText).join('');
    if (node instanceof Y.XmlElement) {
      const block =
        /^(paragraph|heading|blockquote|codeBlock|listItem|bulletList|orderedList)$/i.test(
          node.nodeName,
        );
      return block ? `${content}\n` : content;
    }
    return content;
  }
  return '';
}

export function textFromYjsSnapshot(snapshot: Uint8Array): string {
  const document = new Y.Doc();
  try {
    Y.applyUpdate(document, snapshot);
    let shared: unknown;
    try {
      shared = document.getXmlFragment('default');
    } catch {
      shared = document.getText('default');
    }
    return sharedNodeText(shared)
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  } finally {
    document.destroy();
  }
}

export function diffRevisionLines(previous: string, current: string): RevisionDiffLine[] {
  const before = previous.split('\n').slice(0, 250);
  const after = current.split('\n').slice(0, 250);
  const lengths = Array.from(
    { length: before.length + 1 },
    () => new Uint16Array(after.length + 1),
  );
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left]![right] =
        before[left] === after[right]
          ? lengths[left + 1]![right + 1]! + 1
          : Math.max(lengths[left + 1]![right]!, lengths[left]![right + 1]!);
    }
  }
  const result: RevisionDiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (left < before.length && right < after.length && before[left] === after[right]) {
      result.push({ kind: 'same', text: before[left] ?? '' });
      left += 1;
      right += 1;
    } else if (
      right < after.length &&
      (left >= before.length || lengths[left]![right + 1]! >= lengths[left + 1]![right]!)
    ) {
      result.push({ kind: 'added', text: after[right] ?? '' });
      right += 1;
    } else {
      result.push({ kind: 'removed', text: before[left] ?? '' });
      left += 1;
    }
  }
  return result;
}

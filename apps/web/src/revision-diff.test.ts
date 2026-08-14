import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { diffRevisionLines, textFromYjsSnapshot } from './revision-diff';

describe('revision preview', () => {
  it('extracts readable text from the collaborative document snapshot', () => {
    const document = new Y.Doc();
    const fragment = document.getXmlFragment('default');
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, '第一行');
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);
    expect(textFromYjsSnapshot(Y.encodeStateAsUpdate(document))).toBe('第一行');
    document.destroy();
  });

  it('marks lines added to and removed from the selected revision', () => {
    expect(diffRevisionLines('A\nB', 'A\nC')).toEqual([
      { kind: 'same', text: 'A' },
      { kind: 'added', text: 'C' },
      { kind: 'removed', text: 'B' },
    ]);
  });
});

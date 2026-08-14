import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import { documentPlainText, ftsMatchQuery, searchIndexText } from './search-projection';

describe('search projection', () => {
  it('extracts document text and produces Chinese n-grams', () => {
    const document = new Y.Doc();
    const fragment = document.getXmlFragment('default');
    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Rdocs 协作文档');
    paragraph.insert(0, [text]);
    fragment.insert(0, [paragraph]);
    expect(documentPlainText(document)).toBe('Rdocs 协作文档');
    expect(searchIndexText(documentPlainText(document))).toContain('协作');
    expect(ftsMatchQuery('协作')).toContain('"协作"');
    document.destroy();
  });
});

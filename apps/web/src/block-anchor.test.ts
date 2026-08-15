import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';

import {
  blockAnchorFromHash,
  blockAnchorUrl,
  decodeRelativePosition,
  encodeRelativePosition,
} from './block-anchor';

describe('block anchors', () => {
  it('round-trips Yjs relative positions through a URL-safe fragment', () => {
    const document = new Y.Doc();
    const text = document.getText('content');
    text.insert(0, 'Rdocs block');
    const relative = Y.createRelativePositionFromTypeIndex(text, 6);
    const encoded = encodeRelativePosition(relative);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    const decoded = decodeRelativePosition(encoded);
    const fromHash = blockAnchorFromHash(`#block=${encoded}`);
    expect(decoded && Y.createAbsolutePositionFromRelativePosition(decoded, document)?.index).toBe(
      6,
    );
    expect(
      fromHash && Y.createAbsolutePositionFromRelativePosition(fromHash, document)?.index,
    ).toBe(6);
    document.destroy();
  });

  it('keeps pointing at the same collaborative content after earlier text moves', () => {
    const document = new Y.Doc();
    const text = document.getText('content');
    text.insert(0, 'target block');
    const encoded = encodeRelativePosition(Y.createRelativePositionFromTypeIndex(text, 0));
    text.insert(0, 'new intro ');

    const decoded = decodeRelativePosition(encoded);
    expect(decoded && Y.createAbsolutePositionFromRelativePosition(decoded, document)?.index).toBe(
      10,
    );
    document.destroy();
  });

  it('rejects malformed anchors and builds an encoded page URL', () => {
    expect(blockAnchorFromHash('#block=%25broken')).toBeNull();
    expect(decodeRelativePosition('x'.repeat(4_097))).toBeNull();
    expect(blockAnchorUrl('https://docs.bigrandall.io', 'page/id', 'abc_-')).toBe(
      'https://docs.bigrandall.io/p/page%2Fid#block=abc_-',
    );
  });
});

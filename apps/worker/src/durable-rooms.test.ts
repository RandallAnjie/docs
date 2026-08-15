import { describe, expect, it } from 'vitest';

import { durableRooms } from './durable-rooms';
import type { Env } from './env';

describe('durableRooms', () => {
  it('prefers the uppercase DOCUMENTROOM binding', () => {
    const DOCUMENTROOM = { idFromName: () => 'upper' } as unknown as DurableObjectNamespace;
    const DocumentRoom = { idFromName: () => 'legacy' } as unknown as DurableObjectNamespace;
    expect(durableRooms({ DOCUMENTROOM, DocumentRoom } as Env)).toBe(DOCUMENTROOM);
    expect(durableRooms({ DocumentRoom } as Env)).toBe(DocumentRoom);
    expect(() => durableRooms({} as Env)).toThrow(/DOCUMENTROOM/);
  });
});

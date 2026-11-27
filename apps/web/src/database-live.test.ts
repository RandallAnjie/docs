import { describe, expect, it } from 'vitest';

import { liveReconnectDelay, parseDatabaseLiveMessage } from './database-live';

describe('database live messages', () => {
  it('parses change and presence notes, ignoring anything else', () => {
    expect(
      parseDatabaseLiveMessage(
        JSON.stringify({ type: 'changed', databaseId: 'd', actorId: 'u', at: 5 }),
      ),
    ).toEqual({ type: 'changed', databaseId: 'd', actorId: 'u', at: 5 });
    expect(
      parseDatabaseLiveMessage(
        JSON.stringify({ type: 'presence', viewers: [{ id: 'u', name: 'A' }, { id: 1 }] }),
      ),
    ).toEqual({ type: 'presence', viewers: [{ id: 'u', name: 'A' }] });
    expect(parseDatabaseLiveMessage('pong')).toBeNull();
    expect(parseDatabaseLiveMessage('{bad')).toBeNull();
    expect(parseDatabaseLiveMessage(JSON.stringify({ type: 'other' }))).toBeNull();
  });

  it('backs off reconnects up to 15 seconds', () => {
    expect([0, 1, 2, 3, 4, 10].map(liveReconnectDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000,
    ]);
  });
});

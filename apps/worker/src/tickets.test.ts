import { describe, expect, it } from 'vitest';

import {
  signCollabTicket,
  signDatabaseLiveTicket,
  verifyCollabTicket,
  verifyDatabaseLiveTicket,
  type CollabTicketPayload,
} from './tickets';

const payload: CollabTicketPayload = {
  version: 1,
  pageId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
  generation: 1,
  actorId: 'actor',
  displayName: 'Tester',
  role: 'editor',
  aclVersion: 1,
  issuedAt: 1_000,
  expiresAt: 61_000,
};

describe('collaboration tickets', () => {
  it('round trips a signed ticket', async () => {
    const ticket = await signCollabTicket(payload, 'a sufficiently long test secret');
    await expect(
      verifyCollabTicket(ticket, 'a sufficiently long test secret', 2_000),
    ).resolves.toEqual(payload);
  });

  it('preserves the synced resource discriminator', async () => {
    const syncedPayload: CollabTicketPayload = { ...payload, resourceKind: 'synced_block' };
    const ticket = await signCollabTicket(syncedPayload, 'a sufficiently long test secret');
    await expect(
      verifyCollabTicket(ticket, 'a sufficiently long test secret', 2_000),
    ).resolves.toEqual(syncedPayload);
  });

  it('rejects tampering and expiration', async () => {
    const ticket = await signCollabTicket(payload, 'a sufficiently long test secret');
    await expect(
      verifyCollabTicket(`${ticket}x`, 'a sufficiently long test secret', 2_000),
    ).resolves.toBeNull();
    await expect(
      verifyCollabTicket(ticket, 'a sufficiently long test secret', 70_000),
    ).resolves.toBeNull();
  });
});

describe('database live tickets', () => {
  const secret = 'a sufficiently long test secret';
  const live = {
    version: 'database-live-1' as const,
    databaseId: '6863a1ea-2cc1-4a74-9019-8449a04d2246',
    actorId: 'actor',
    displayName: 'Tester',
    issuedAt: 1_000,
    expiresAt: 61_000,
  };

  it('round trips and expires', async () => {
    const ticket = await signDatabaseLiveTicket(live, secret);
    await expect(verifyDatabaseLiveTicket(ticket, secret, 2_000)).resolves.toEqual(live);
    await expect(verifyDatabaseLiveTicket(ticket, secret, 61_000)).resolves.toBeNull();
    await expect(
      verifyDatabaseLiveTicket(ticket, 'another long secret value', 2_000),
    ).resolves.toBeNull();
  });

  it('is never accepted as a collaboration ticket, nor the reverse', async () => {
    const liveTicket = await signDatabaseLiveTicket(live, secret);
    await expect(verifyCollabTicket(liveTicket, secret, 2_000)).resolves.toBeNull();
    const collabTicket = await signCollabTicket(payload, secret);
    await expect(verifyDatabaseLiveTicket(collabTicket, secret, 2_000)).resolves.toBeNull();
  });
});

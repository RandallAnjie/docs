import { describe, expect, it } from 'vitest';

import { signCollabTicket, verifyCollabTicket, type CollabTicketPayload } from './tickets';

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

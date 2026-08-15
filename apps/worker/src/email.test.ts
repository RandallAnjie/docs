import { describe, expect, it } from 'vitest';

import { extractEmailAddress, invitationEmailBodies, pageIdFromMailbox } from './email';
import { parseIcsEvents } from './platform';
import { parseSimpleCron } from './cron';

describe('RandallFlare email helpers', () => {
  it('extracts page ids from inbound mailboxes', () => {
    expect(pageIdFromMailbox('page+11111111-1111-4111-8111-111111111111@docs.bigrandall.io')).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(pageIdFromMailbox('not-a-page@docs.bigrandall.io')).toBeNull();
    expect(extractEmailAddress('Ada <ada@example.com>')).toBe('ada@example.com');
  });

  it('renders invitation copy with an accept link', () => {
    const bodies = invitationEmailBodies({
      acceptUrl: 'https://docs.bigrandall.io/invite/token',
      organizationName: 'Acme',
    });
    expect(bodies.text).toContain('https://docs.bigrandall.io/invite/token');
    expect(bodies.html).toContain('Acme');
  });
});

describe('calendar and cron helpers', () => {
  it('parses ICS events', () => {
    const events = parseIcsEvents(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:standup-1
DTSTART:20260815T010000Z
DTEND:20260815T013000Z
SUMMARY:Standup
LOCATION:Room 1
END:VEVENT
END:VCALENDAR`);
    expect(events).toHaveLength(1);
    expect(events[0]?.title).toBe('Standup');
    expect(events[0]?.location).toBe('Room 1');
    expect(events[0]?.startsAt).toBe(Date.UTC(2026, 7, 15, 1, 0, 0));
  });

  it('computes the next UTC cron tick', () => {
    const from = Date.UTC(2026, 7, 15, 8, 0, 0);
    expect(parseSimpleCron('0 9 * * *', from)).toBe(Date.UTC(2026, 7, 15, 9, 0, 0));
    expect(parseSimpleCron('0 9 * * *', Date.UTC(2026, 7, 15, 10, 0, 0))).toBe(
      Date.UTC(2026, 7, 16, 9, 0, 0),
    );
  });
});

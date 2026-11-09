import { describe, expect, it } from 'vitest';
import { dateTime, meetingTime } from '../../src/renderer/format.js';

describe('a whole day is the day its UTC time names', () => {
  it('in the source pane and on a card, whatever the meeting\'s or this computer\'s time zone', () => {
    // A meeting tool's all-day event is midnight UTC, another provider's noon UTC.
    for (const iso of ['2026-10-21T00:00:00.000Z', '2026-10-21T12:00:00.000Z']) {
      for (const zone of [undefined, 'UTC', 'America/Los_Angeles', 'Pacific/Kiritimati']) expect(meetingTime(iso, zone, true)).toMatch(/^Oct 21, 2026$/);
      expect(dateTime(iso, true)).toBe('Oct 21');
    }
    // A timed meeting keeps its own time zone.
    expect(meetingTime('2026-10-21T00:00:00.000Z', 'America/Los_Angeles')).toMatch(/^Oct 20, 2026, 5:00\sPM PDT$/);
  });
});

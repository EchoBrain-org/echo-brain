import { describe, expect, it } from 'vitest';
import { evidenceDayV1, matchesEvidenceDateV1, validateEvidenceDateFilterV1 } from '../../src/shared/temporal-query-v1.js';

describe('structured temporal filters', () => {
  it('compares whole client-local calendar days across both daylight-saving transitions', () => {
    const zone = 'America/Los_Angeles';
    for (const [date, inside, outside] of [
      ['2026-03-08', '2026-03-09T06:59:59Z', '2026-03-09T07:00:00Z'],
      ['2026-11-01', '2026-11-02T07:59:59Z', '2026-11-02T08:00:00Z'],
    ]) {
      const filter = { since: date!, until: date!, time_zone: zone };
      expect(matchesEvidenceDateV1({ occurred: inside! }, filter, 'occurred')).toBe(true);
      expect(matchesEvidenceDateV1({ occurred: outside! }, filter, 'occurred')).toBe(false);
    }
    expect(evidenceDayV1('2026-10-16', 'Pacific/Auckland')).toBe('2026-10-16');
  });

  it('never substitutes a received or created date for missing event dates', () => {
    const filter = { since: '2026-10-16', until: '2026-10-16' };
    expect(matchesEvidenceDateV1({ received: '2026-10-16T12:00:00Z' }, filter, 'occurred')).toBe(false);
    expect(matchesEvidenceDateV1({ created: '2026-10-16T12:00:00Z', updated: '2026-10-17T12:00:00Z' }, { ...filter, date_field: 'updated' }, 'created')).toBe(false);
  });

  it.each([{ since: '2026-02-30' }, { since: 'yesterday' }, { since: '2026-10-17', until: '2026-10-16' }, { time_zone: 'Not/AZone' }])('rejects invalid structured input %j', filter => {
    expect(() => validateEvidenceDateFilterV1(filter)).toThrow();
  });
});

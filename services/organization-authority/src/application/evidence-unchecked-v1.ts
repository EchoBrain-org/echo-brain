import type { EvidenceDeskUncheckedV1 } from '@echo-brain/organization-authority-kernel/shared/evidence-desk-v2';
import { EVIDENCE_ANY_DATE_V1, EVIDENCE_DATE_FIELDS_V1, type EvidenceDateFieldV1, type EvidenceDateSelectionV1, type EvidenceDatesV1 } from '@echo-brain/organization-authority-kernel/shared/temporal-query-v1';

/**
 * What a dated read could not test (research tool contract v1): each item that does not record the date the read tests
 * (for `any`, no date at all) is counted, with the dates such items do record.
 */
export function createUncheckedTallyV1() {
  let count = 0;
  const carried = new Set<EvidenceDateFieldV1>();
  return Object.freeze({
    /** Whether `dates` records `field`; one that does not is counted. */
    tests(dates: EvidenceDatesV1, field: EvidenceDateSelectionV1): boolean {
      const recorded = EVIDENCE_DATE_FIELDS_V1.filter(name => dates[name] !== undefined);
      if (field === EVIDENCE_ANY_DATE_V1 ? recorded.length > 0 : dates[field] !== undefined) return true;
      count += 1;
      for (const name of recorded) carried.add(name);
      return false;
    },
    unchecked(): EvidenceDeskUncheckedV1 | undefined {
      return count === 0 ? undefined : Object.freeze({ count, dates: Object.freeze(EVIDENCE_DATE_FIELDS_V1.filter(name => carried.has(name))) });
    },
  });
}

/** Several reads' untested items as one: their counts summed, and every date any of them carries, in date-field order. */
export function mergeUncheckedV1(values: readonly (EvidenceDeskUncheckedV1 | undefined)[]): EvidenceDeskUncheckedV1 | undefined {
  const counted = values.filter((value): value is EvidenceDeskUncheckedV1 => value !== undefined && value.count !== 0);
  return counted.length === 0 ? undefined : Object.freeze({
    count: counted.reduce((total, value) => total + value.count, 0),
    dates: Object.freeze(EVIDENCE_DATE_FIELDS_V1.filter(field => counted.some(value => value.dates.includes(field)))),
  });
}

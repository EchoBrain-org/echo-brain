import { asEnumerableRecord, assertDigest, assertExactKeys, fail } from './validation.js';

/**
 * The change check (desktop refresh and notifications v1; ADR-0036). A
 * signed-in person asks what changed in their own view: one fingerprint per
 * area, each a digest of rows that person may read, so a fingerprint moves
 * only with activity they can see (ADR-0012). It returns no content; the
 * desktop reads an area again only when its fingerprint moved, and asks again
 * after `check_again_after_seconds`, which the server may raise when busy.
 */
export const PERSON_CHANGES_ROUTE_V1 = '/v1/person/changes';
export const PERSON_CHANGES_KIND_V1 = 'echo-person-changes-v1';

/**
 * `projects`: the projects you belong to, active and archived (id, name, status, your role).
 * `follow_ups`: the follow-ups you are involved in and may read (you sent it, own it, or last handed it on), with
 * their state, owner and when the owner or state was last set; checks are left out.
 * `reviews`: the meetings waiting for your review.
 */
export const PERSON_CHANGES_AREAS_V1 = ['projects', 'follow_ups', 'reviews'] as const;
export type PersonChangesAreaV1 = (typeof PERSON_CHANGES_AREAS_V1)[number];

/** The shortest and longest wait the server may ask for. */
export const PERSON_CHANGES_CHECK_SECONDS_V1 = Object.freeze({ min: 15, default: 60, max: 3600 });

export interface PersonChangesV1 {
  readonly kind: typeof PERSON_CHANGES_KIND_V1;
  /** One canonical SHA-256 digest (`sha256:<64 hex>`) per area. */
  readonly areas: Readonly<Record<PersonChangesAreaV1, string>>;
  readonly check_again_after_seconds: number;
}

export function validatePersonChangesV1(value: unknown): PersonChangesV1 {
  const record = asEnumerableRecord(value, 'Person changes');
  assertExactKeys(record, ['kind', 'areas', 'check_again_after_seconds'], 'Person changes');
  if (record.kind !== PERSON_CHANGES_KIND_V1) fail('Person changes kind is invalid');
  const areas = asEnumerableRecord(record.areas, 'Person changes areas');
  assertExactKeys(areas, PERSON_CHANGES_AREAS_V1, 'Person changes areas');
  for (const area of PERSON_CHANGES_AREAS_V1) assertDigest(areas[area], `Person changes ${area}`);
  const seconds = record.check_again_after_seconds;
  if (typeof seconds !== 'number' || !Number.isSafeInteger(seconds) ||
      seconds < PERSON_CHANGES_CHECK_SECONDS_V1.min || seconds > PERSON_CHANGES_CHECK_SECONDS_V1.max) {
    fail('Person changes check_again_after_seconds is invalid');
  }
  return Object.freeze({
    kind: PERSON_CHANGES_KIND_V1,
    areas: Object.freeze({ projects: areas.projects as string, follow_ups: areas.follow_ups as string, reviews: areas.reviews as string }),
    check_again_after_seconds: seconds,
  });
}

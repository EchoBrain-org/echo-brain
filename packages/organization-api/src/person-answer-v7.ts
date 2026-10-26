import type { PersonAnswerCitationV4 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV6, PersonEvidenceKindV3 } from './person-answer-v6.js';
import type { PersonFollowUpCitationV1, PersonFollowUpRefV1 } from './person-follow-up-evidence-v1.js';
import type { PersonItemRefV1 } from './person-list-v1.js';

/**
 * Follow-up citations (ADR-0040), which the V7 answer added. That answer and its route, `/v6/person/ask`, were retired;
 * the V8 answer's citations build on these.
 */
export type PersonEvidenceKindV4 = PersonEvidenceKindV3 | 'follow_up';
export type PersonAnswerEvidenceCitationV7 = PersonAnswerEvidenceCitationV6 | PersonFollowUpCitationV1;
/** A follow-up citation always carries its follow-up ref; every other kind keeps the person-open refs of V4. */
export type PersonAnswerOpenRefV7 = PersonItemRefV1 | PersonFollowUpRefV1;
export interface PersonAnswerCitationV7 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind' | 'ref'> {
  readonly citation: PersonAnswerEvidenceCitationV7;
  readonly kind: PersonEvidenceKindV4;
  readonly ref?: PersonAnswerOpenRefV7;
}

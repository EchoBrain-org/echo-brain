import type { PersonAnswerCitationV4, PersonAnswerResponseV4 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV6, PersonEvidenceKindV3 } from './person-answer-v6.js';
import type { PersonFollowUpCitationV1, PersonFollowUpRefV1 } from './person-follow-up-evidence-v1.js';
import type { PersonOpenRefV1 } from './person-list-v1.js';

/**
 * V7 adds follow-up citations (ADR-0040). The V3 request shape is unchanged.
 * A matched response on this path carries `PERSON_ANSWER_ROUTE_HEADER_V5`
 * with the value `6`, as `/v5/person/ask` carries it with `5`.
 */
export const PERSON_ANSWER_PATH_V6 = '/v6/person/ask';
export type PersonEvidenceKindV4 = PersonEvidenceKindV3 | 'follow_up';
export type PersonAnswerEvidenceCitationV7 = PersonAnswerEvidenceCitationV6 | PersonFollowUpCitationV1;
/** A follow-up citation always carries its follow-up ref; every other kind keeps the person-open refs of V4. */
export type PersonAnswerOpenRefV7 = PersonOpenRefV1 | PersonFollowUpRefV1;
export interface PersonAnswerCitationV7 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind' | 'ref'> {
  readonly citation: PersonAnswerEvidenceCitationV7;
  readonly kind: PersonEvidenceKindV4;
  readonly ref?: PersonAnswerOpenRefV7;
}
export interface PersonAnswerResponseV7 extends Omit<PersonAnswerResponseV4, 'schema_version' | 'kind' | 'citations'> {
  readonly schema_version: 7;
  readonly kind: 'echo-clean-person-answer-v7';
  readonly citations: readonly PersonAnswerCitationV7[];
}

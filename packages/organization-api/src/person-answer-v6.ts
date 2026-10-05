import type { PersonAnswerCitationV4, PersonAnswerResponseV4 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV5, PersonEvidenceKindV2 } from './person-answer-v5.js';
import type { PersonPageCitationV1 } from './person-page-citation-v1.js';

/** V6 adds live, request-only page citations. The V3 request shape is unchanged. */
export const PERSON_ANSWER_PATH_V5 = '/v5/person/ask';
export type PersonEvidenceKindV3 = PersonEvidenceKindV2 | 'page';
export type PersonAnswerEvidenceCitationV6 = PersonAnswerEvidenceCitationV5 | PersonPageCitationV1;
export interface PersonAnswerCitationV6 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind'> {
  readonly citation: PersonAnswerEvidenceCitationV6;
  readonly kind: PersonEvidenceKindV3;
}
export interface PersonAnswerResponseV6 extends Omit<PersonAnswerResponseV4, 'schema_version' | 'kind' | 'citations'> {
  readonly schema_version: 6;
  readonly kind: 'echo-clean-person-answer-v6';
  readonly citations: readonly PersonAnswerCitationV6[];
}

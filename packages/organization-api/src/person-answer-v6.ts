import type { PersonAnswerCitationV4 } from './person-answer-v4.js';
import type { PersonAnswerEvidenceCitationV5, PersonEvidenceKindV2 } from './person-answer-v5.js';
import type { PersonPageCitationV1 } from './person-page-citation-v1.js';

/**
 * Live page citations, which the V6 answer added. That answer and its route, `/v5/person/ask`, were retired; a V6
 * citation is what an impact card cites (person-impact-card-v1.ts), and the V8 answer's citations build on it.
 */
export type PersonEvidenceKindV3 = PersonEvidenceKindV2 | 'page';
export type PersonAnswerEvidenceCitationV6 = PersonAnswerEvidenceCitationV5 | PersonPageCitationV1;
export interface PersonAnswerCitationV6 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind'> {
  readonly citation: PersonAnswerEvidenceCitationV6;
  readonly kind: PersonEvidenceKindV3;
}

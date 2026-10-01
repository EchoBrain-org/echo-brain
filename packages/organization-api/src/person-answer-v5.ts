import type { PersonAnswerCitationV4, PersonAnswerResponseV4, PersonAnswerEvidenceCitationV4, PersonEvidenceDeskItemV1, PersonEvidenceDeskResponseV1, PersonEvidenceKindV1 } from './person-answer-v4.js';
import type { PersonTicketCitationV1 } from './person-ticket-citation-v1.js';

/** The request remains V3; only the response adds ticket citations. */
export const PERSON_ANSWER_PATH_V4 = '/v4/person/ask';
export type PersonEvidenceKindV2 = PersonEvidenceKindV1 | 'ticket';
export type PersonAnswerEvidenceCitationV5 = PersonAnswerEvidenceCitationV4 | PersonTicketCitationV1;
export interface PersonAnswerCitationV5 extends Omit<PersonAnswerCitationV4, 'citation' | 'kind'> { readonly citation: PersonAnswerEvidenceCitationV5; readonly kind: PersonEvidenceKindV2 }
export interface PersonAnswerResponseV5 extends Omit<PersonAnswerResponseV4, 'schema_version' | 'kind' | 'citations'> {
  readonly schema_version: 5;
  readonly kind: 'echo-clean-person-answer-v5';
  readonly citations: readonly PersonAnswerCitationV5[];
}
export interface PersonEvidenceDeskItemV2 extends Omit<PersonEvidenceDeskItemV1, 'citation' | 'kind'> { readonly citation: PersonAnswerEvidenceCitationV5; readonly kind: PersonEvidenceKindV2 }
export interface PersonEvidenceDeskResponseV2 extends Omit<PersonEvidenceDeskResponseV1, 'schema_version' | 'kind' | 'items'> {
  readonly schema_version: 2;
  readonly kind: 'echo-person-evidence-desk-v2';
  readonly items: readonly PersonEvidenceDeskItemV2[];
}

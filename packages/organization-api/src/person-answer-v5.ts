import type { PersonAnswerEvidenceCitationV4, PersonEvidenceKindV1 } from './person-answer-v4.js';
import type { PersonTicketCitationV1 } from './person-ticket-citation-v1.js';

/**
 * Ticket citations, which the V5 answer added. That answer and its route, `/v4/person/ask`, were retired; an impact
 * card's V6 citations and the V8 answer's build on these.
 */
export type PersonEvidenceKindV2 = PersonEvidenceKindV1 | 'ticket';
export type PersonAnswerEvidenceCitationV5 = PersonAnswerEvidenceCitationV4 | PersonTicketCitationV1;

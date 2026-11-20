import type { PersonAnswerStatementV4 } from './person-answer-v4.js';
import type { PersonAnswerCitationV8 } from './person-answer-v8.js';

/**
 * The previous turn on Ask (ADR-0047, Ask timeline v1 C3). An Ask on
 * `POST /v7/person/ask` may carry `previous`: the earlier turn's full
 * question, when it was asked, and the sentences of its answer the asker can
 * still read, with the citations that answer carried. It is the asker's own
 * context, like the question, and it is never evidence. The Authority does
 * not store it. At request time it checks every citation in it for the
 * asker, and a sentence that rests on a citation the asker cannot read any
 * more is removed before any model sees it; the question always stays.
 *
 * - `follow_up`: before research, one resolver call works out what the
 *   question refers to. The answer then answers the full question it
 *   resolved, starting research from the earlier citations it is about; or,
 *   when more than one thing could fit, it asks which one (outcome `clarify`,
 *   with `choices`); or the question stands alone and is answered as asked.
 * - `ask_again`: the same question again: the request's `question` must be
 *   the earlier `question` itself, or the request is refused
 *   (`invalid_request`). The answer also says what is different `since` the
 *   earlier answer, each sentence citing current evidence.
 *
 * Only an answer to a request that carried `previous` names its `question`,
 * and only such an answer may carry `since` or `choices`: a client that never
 * sends it never meets them.
 */

/**
 * The earlier answer a request carries is the whole answer as it was released, so a follow-up can point at any of it:
 * the API counts none of its sentences or citations; the request's transport bound decides what fits.
 */

export type PersonAnswerPreviousPurposeV1 = 'follow_up' | 'ask_again';

/** One sentence of the earlier answer, citing the request's `citations` by index. */
export interface PersonAnswerPreviousStatementV1 {
  readonly text: string;
  /** Distinct indexes into the previous turn's `citations`. */
  readonly citation_indexes: readonly number[];
}

export interface PersonAnswerPreviousV1 {
  readonly purpose: PersonAnswerPreviousPurposeV1;
  /** The earlier turn's full question, within the question bound. */
  readonly question: string;
  /** When the earlier turn was asked: ISO-8601 UTC with milliseconds. */
  readonly asked_at: string;
  /** The sentences of the earlier answer the asker can still read. */
  readonly statements: readonly PersonAnswerPreviousStatementV1[];
  /** The earlier answer's citations, as its response carried them, each once. */
  readonly citations: readonly PersonAnswerCitationV8[];
}

/**
 * One thing a follow-up could mean: a short label naming it, and the full
 * question to ask about it, which passes the question rules (so at most 240
 * characters) and is asked as it is when chosen.
 */
export interface PersonAnswerChoiceV1 {
  readonly label: string;
  readonly question: string;
}

/**
 * What is different since the earlier answer (Ask again): each statement
 * cites current evidence among the answer's citations. No statements means
 * nothing material changed; an answer that could not compare carries no
 * `since` at all.
 */
export interface PersonAnswerSinceV1 {
  readonly statements: readonly PersonAnswerStatementV4[];
}

import type { PersonAnswerStatementV4 } from './person-answer-v4.js';
import type { PersonAnswerCitationV8 } from './person-answer-v8.js';

/**
 * The previous turn on Ask (ADR-0047, Ask timeline v1 C3). An Ask on
 * `POST /v7/person/ask` may carry `previous`: the earlier turn's full
 * question, when it was asked, and the sentences of its answer the asker can
 * still read, with the citations that answer carried. It is the asker's own
 * context, like the question: the Authority neither verifies nor stores it,
 * and it is never evidence.
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

/** Sentences of the earlier answer a request carries. */
export const PERSON_ANSWER_PREVIOUS_MAX_STATEMENTS_V1 = 8;
/** Unicode characters (code points) of one earlier sentence. */
export const PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1 = 400;
/** The earlier answer's citations a request carries; its sentences index into them. */
export const PERSON_ANSWER_PREVIOUS_MAX_CITATIONS_V1 = 12;
/** Citations one earlier sentence names. */
export const PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CITATIONS_V1 = 4;
/** Sentences of what is different since the earlier answer. */
export const PERSON_ANSWER_SINCE_MAX_STATEMENTS_V1 = 6;
export const PERSON_ANSWER_CHOICES_MIN_V1 = 2;
export const PERSON_ANSWER_CHOICES_MAX_V1 = 4;
/** Unicode characters (code points) of a choice's label. */
export const PERSON_ANSWER_CHOICE_LABEL_MAX_CHARS_V1 = 60;

export type PersonAnswerPreviousPurposeV1 = 'follow_up' | 'ask_again';

/** One sentence of the earlier answer, citing the request's `citations` by index. */
export interface PersonAnswerPreviousStatementV1 {
  readonly text: string;
  /** 0 to 4 distinct indexes into the previous turn's `citations`. */
  readonly citation_indexes: readonly number[];
}

export interface PersonAnswerPreviousV1 {
  readonly purpose: PersonAnswerPreviousPurposeV1;
  /** The earlier turn's full question, within the question bound. */
  readonly question: string;
  /** When the earlier turn was asked: ISO-8601 UTC with milliseconds. */
  readonly asked_at: string;
  /** 0 to 8 sentences of the earlier answer the asker can still read, each at most 400 characters. */
  readonly statements: readonly PersonAnswerPreviousStatementV1[];
  /** 0 to 12 of the earlier answer's citations, as its response carried them, each once. */
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

import { utf8ByteLength } from './validation.js';

/**
 * Each Ask and search input rule's code and its static message. The Authority answers a refusal with both; a client
 * names the rule from the code alone, from its own copy of this table, and never shows the Authority's text.
 */
export const PERSON_QUERY_INPUT_MESSAGES_V1: Readonly<Record<string, string>> = Object.freeze({
  question_empty: 'Enter a question.',
  question_normalization: 'Send the question as NFC-normalized Unicode text.',
  question_whitespace: 'Remove spaces and line breaks from the start and end of the question.',
  question_controls: 'Remove control characters from the question; line breaks and tabs are fine.',
  query_empty: 'Enter a question or search query containing text.',
  query_normalization: 'Use NFC-normalized Unicode text for the question or search query.',
  query_whitespace: 'Remove leading and trailing whitespace from the question or search query.',
  query_controls: 'Use a single line without control characters for the question or search query.',
  query_too_long: 'Shorten the question or search query to at most 240 Unicode code points.',
  query_term_count: 'Include at least one letter or number in the question or search query.',
  query_term_too_long: 'Shorten each normalized term to at most 64 UTF-8 bytes; non-ASCII letters can use multiple bytes.',
});

/** Shared public Ask and search input rules. No input echoing; each refusal names its rule in a static message. */
export class PersonQueryInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PersonQueryInputError';
  }
}

/** A refusal by one rule of PERSON_QUERY_INPUT_MESSAGES_V1. */
function refused(code: string): never {
  throw new PersonQueryInputError(code, PERSON_QUERY_INPUT_MESSAGES_V1[code]!);
}

/** Controls a question may not hold: every C0 and C1 control but tab, line feed and carriage return, and lone surrogates. */
const QUESTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u;

/**
 * An Ask question as a client sends it: NFC, without surrounding whitespace, and not empty. This is the client's only
 * check before sending; the Authority applies validatePersonQuestionText and says which rule a question breaks.
 */
export function personQuestionToSend(value: string): string {
  const question = value.normalize('NFC').trim();
  if (question.length === 0) refused('question_empty');
  return question;
}

/**
 * The Ask question rule, for the question a person asks, the earlier question a follow-up carries, and the questions
 * the follow-up resolver writes. Natural language: no term or per-term rule, line breaks and tabs are allowed, and it has
 * no length of its own: the request that carries it is bounded by its transport (PERSON_ANSWER_REQUEST_MAX_BYTES_V3).
 * Clients send personQuestionToSend's form, so text that is not NFC or not trimmed is refused here, never rewritten.
 */
export function validatePersonQuestionText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) refused('question_empty');
  if (value !== value.normalize('NFC')) refused('question_normalization');
  if (value.trim() !== value) refused('question_whitespace');
  if (QUESTION_CONTROLS.test(value)) refused('question_controls');
  return value;
}

/** The keyword search rule (record search and the research model's desk search): one line of at most 240 code points. */
export function validatePersonQueryText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) refused('query_empty');
  if (value !== value.normalize('NFC')) refused('query_normalization');
  if (value.trim() !== value) refused('query_whitespace');
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) refused('query_controls');
  if ([...value].length > 240) refused('query_too_long');
  const terms = new Set((value.match(/[\p{L}\p{N}]+/gu) ?? []).map(term => term.toLowerCase().normalize('NFC')));
  if (terms.size === 0) refused('query_term_count');
  if ([...terms].some(term => utf8ByteLength(term) > 64)) refused('query_term_too_long');
  return value;
}

import { utf8ByteLength } from './validation.js';

/** Shared public Ask and search input rules. No input echoing; each refusal names its rule in a static message. */
export class PersonQueryInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PersonQueryInputError';
  }
}

/**
 * The longest Ask question, in Unicode code points. A question is natural language read by the research model, so it may
 * be a pasted paragraph or a short email; at 4 bytes a code point it stays well inside the 64 KiB Ask request body.
 */
export const PERSON_QUESTION_MAX_CODE_POINTS_V1 = 4_000;

/** Controls a question may not hold: every C0 and C1 control but tab, line feed and carriage return, and lone surrogates. */
const QUESTION_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uD800-\uDFFF]/u;

/**
 * An Ask question as a client sends it: NFC, without surrounding whitespace, and not empty. This is the client's only
 * check before sending; the Authority applies validatePersonQuestionText and says which rule a question breaks.
 */
export function personQuestionToSend(value: string): string {
  const question = value.normalize('NFC').trim();
  if (question.length === 0) throw new PersonQueryInputError('question_empty', 'Enter a question.');
  return question;
}

/**
 * The Ask question rule, for the question a person asks, the earlier question a follow-up carries, and the questions
 * the follow-up resolver writes. Natural language: no term or per-term rule, and line breaks and tabs are allowed.
 * Clients send personQuestionToSend's form, so text that is not NFC or not trimmed is refused here, never rewritten.
 */
export function validatePersonQuestionText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PersonQueryInputError('question_empty', 'Enter a question.');
  }
  if (value !== value.normalize('NFC')) {
    throw new PersonQueryInputError('question_normalization', 'Send the question as NFC-normalized Unicode text.');
  }
  if (value.trim() !== value) {
    throw new PersonQueryInputError('question_whitespace', 'Remove spaces and line breaks from the start and end of the question.');
  }
  if (QUESTION_CONTROLS.test(value)) {
    throw new PersonQueryInputError('question_controls', 'Remove control characters from the question; line breaks and tabs are fine.');
  }
  if ([...value].length > PERSON_QUESTION_MAX_CODE_POINTS_V1) {
    throw new PersonQueryInputError('question_too_long', 'Shorten the question to at most 4,000 characters.');
  }
  return value;
}

/** The keyword search rule (record search and the research model's desk search): one line of at most 240 code points. */
export function validatePersonQueryText(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new PersonQueryInputError('query_empty', 'Enter a question or search query containing text.');
  }
  if (value !== value.normalize('NFC')) {
    throw new PersonQueryInputError('query_normalization', 'Use NFC-normalized Unicode text for the question or search query.');
  }
  if (value.trim() !== value) {
    throw new PersonQueryInputError('query_whitespace', 'Remove leading and trailing whitespace from the question or search query.');
  }
  if (/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) {
    throw new PersonQueryInputError('query_controls', 'Use a single line without control characters for the question or search query.');
  }
  if ([...value].length > 240) {
    throw new PersonQueryInputError('query_too_long', 'Shorten the question or search query to at most 240 Unicode code points.');
  }
  const terms = new Set((value.match(/[\p{L}\p{N}]+/gu) ?? []).map(term => term.toLowerCase().normalize('NFC')));
  if (terms.size === 0) {
    throw new PersonQueryInputError('query_term_count', 'Include at least one letter or number in the question or search query.');
  }
  if ([...terms].some(term => utf8ByteLength(term) > 64)) {
    throw new PersonQueryInputError('query_term_too_long', 'Shorten each normalized term to at most 64 UTF-8 bytes; non-ASCII letters can use multiple bytes.');
  }
  return value;
}

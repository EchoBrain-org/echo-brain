/** Shared public Ask/search input rules. No normalization or input echoing. */
export class PersonQueryInputError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'PersonQueryInputError';
  }
}

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
  if (terms.size < 1 || terms.size > 32) {
    throw new PersonQueryInputError('query_term_count', 'Use 1 to 32 distinct normalized letter/number terms in the question or search query.');
  }
  if ([...terms].some(term => [...term].reduce((bytes, character) => {
    const point = character.codePointAt(0)!;
    return bytes + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0) > 64)) {
    throw new PersonQueryInputError('query_term_too_long', 'Shorten each normalized term to at most 64 UTF-8 bytes; non-ASCII letters can use multiple bytes.');
  }
  return value;
}

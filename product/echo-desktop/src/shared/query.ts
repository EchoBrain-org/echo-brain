// The bar's text as the API takes it. The page uses these to decide what to
// send; the host uses them again before anything reaches the client.

/** A question the API accepts: NFC, one line, trimmed, at most 240 code points. */
export function askText(question: string): string {
  const line = question.normalize('NFC').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return [...line].slice(0, 240).join('').trim();
}

/** The distinct words of a query, as the API matches them: letters and numbers, lower-cased. */
export function queryTerms(query: string): string[] {
  return [...new Set((query.normalize('NFC').match(/[\p{L}\p{N}]+/gu) ?? []).map(term => term.toLowerCase().normalize('NFC')))];
}

/**
 * Bar text a live search can run: the question it would ask, with at least
 * two characters that are not spaces, and 1 to 32 distinct words of at most
 * 64 UTF-8 bytes each (the API's search bounds). Anything else is only asked.
 */
export function searchQuery(text: string): string | null {
  const query = askText(text);
  if ([...query.replace(/\s/gu, '')].length < 2) return null;
  const terms = queryTerms(query);
  if (terms.length < 1 || terms.length > 32) return null;
  if (terms.some(term => new TextEncoder().encode(term).length > 64)) return null;
  return query;
}

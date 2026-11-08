// The bar's text as the API takes it. The page uses this to decide what to
// send; the host uses it again before anything reaches the client.

/** A question the API accepts: NFC, one line, trimmed, at most 240 code points. */
export function askText(question: string): string {
  const line = question.normalize('NFC').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return [...line].slice(0, 240).join('').trim();
}

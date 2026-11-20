// The bar's text as it is sent. The page uses this to decide what to send;
// the host uses it again before anything reaches the client.

/**
 * A question as it is sent: NFC, trimmed, with every control but tab and line breaks made a space. It is never cut:
 * the Authority judges its length and says when it is too long.
 */
export function askText(question: string): string {
  return question.normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]+/gu, ' ').trim();
}

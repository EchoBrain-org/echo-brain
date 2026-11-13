/** A `/v7` Ask's reply: its answer, streamed (ADR-0039), unchecked, with an empty receipt. */
export function askStream(answer: unknown): Response {
  return new Response(`data: ${JSON.stringify({ type: 'answer', response: answer, receipt: { looked_through: 0, elapsed_ms: 0, rows: [] } })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
}

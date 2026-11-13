/** The last line `person ask --progress` prints: the answer and its stream's receipt, which every Ask has (ADR-0039). */
export const askLine = (result: unknown, receipt: unknown = { looked_through: 0, elapsed_ms: 0, rows: [] }) => ({ ok: true, result, receipt });

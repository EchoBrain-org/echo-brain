const K1 = 1.2;
const B = 0.75;
const SCALE = 1_000_000;

export type OriginalContextPacketAnalysisV1 = Readonly<{
  length: number;
  frequencies: ReadonlyMap<string, number>;
}>;

/** Query-local analysis for stable original-context packets. */
export function analyzeOriginalContextPacketV1(text: string, terms: readonly string[]): OriginalContextPacketAnalysisV1 {
  const wanted = new Set(terms);
  const frequencies = new Map<string, number>();
  const tokens = text.normalize("NFC").toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const token of tokens) {
    if (wanted.has(token)) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
  }
  return Object.freeze({ length: tokens.length, frequencies });
}

/** Plain Okapi BM25: unlike approved-record scoring, no category term receives a boost. */
export function scoreOriginalContextPacketV1(
  analysis: OriginalContextPacketAnalysisV1,
  terms: readonly string[],
  documentCount: number,
  averageLength: number,
  documentFrequencies: ReadonlyMap<string, number>,
): number {
  if (documentCount === 0 || averageLength === 0) return 0;
  let score = 0;
  for (const term of terms) {
    const frequency = analysis.frequencies.get(term) ?? 0;
    if (frequency === 0) continue;
    const documentFrequency = documentFrequencies.get(term) ?? 0;
    const idf = Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
    const saturation = (frequency * (K1 + 1)) /
      (frequency + K1 * (1 - B + (B * analysis.length) / averageLength));
    score += idf * saturation;
  }
  return Math.round(score * SCALE);
}

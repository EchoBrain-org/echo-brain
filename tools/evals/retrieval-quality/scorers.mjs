/**
 * Scoring functions for the retrieval-quality benchmark.
 *
 * `tfsum` and `bm25` are small reference implementations kept here so a
 * baseline checkout can report what each formula would produce.  `real`
 * delegates to whatever scorer the built analyzer exports, so the same command
 * measures the shipped code before and after a scoring change.
 *
 * Every scorer receives:
 *   frequencies  Map<term, tf> for one document (the analyzer's output)
 *   length       document length = sum of tf over all terms
 *   queryTerms   analyzed, deduplicated, family-expanded query terms
 *   statistics   { document_count, total_term_count, document_frequency: Map }
 * and returns a number; higher ranks first.  Ties are broken by the engine's
 * comparator, never by the scorer.
 */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const FIXED_POINT_SCALE = 1_000_000;

export function tfSum(frequencies, _length, queryTerms) {
  let score = 0;
  for (const term of queryTerms) score += frequencies.get(term) ?? 0;
  return score;
}

/** Robertson/Sparck-Jones IDF with the +1 floor used by Lucene, as a fixed-point integer. */
export function bm25IdfFixed(documentFrequency, documentCount) {
  if (documentFrequency <= 0) return 0;
  const value = Math.log(
    1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
  return Math.round(value * FIXED_POINT_SCALE);
}

export function bm25(frequencies, length, queryTerms, statistics, options = {}) {
  const k1 = options.k1 ?? BM25_K1;
  const b = options.b ?? BM25_B;
  const controlled = options.controlled_terms ?? new Set();
  const documentCount = statistics.document_count;
  const averageLength =
    documentCount === 0 ? 0 : statistics.total_term_count / documentCount;
  let score = 0;
  for (const term of queryTerms) {
    const tf = frequencies.get(term) ?? 0;
    if (tf === 0) continue;
    const normalized =
      averageLength === 0
        ? 1
        : (tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / averageLength));
    const idf = controlled.has(term)
      ? FIXED_POINT_SCALE
      : bm25IdfFixed(statistics.document_frequency.get(term) ?? 0, documentCount);
    score += Math.round(idf * normalized);
  }
  return score;
}

export function documentLength(frequencies) {
  let total = 0;
  for (const tf of frequencies.values()) total += tf;
  return total;
}

export function collectStatistics(documents) {
  const document_frequency = new Map();
  let total_term_count = 0;
  for (const frequencies of documents) {
    total_term_count += documentLength(frequencies);
    for (const term of frequencies.keys()) {
      document_frequency.set(term, (document_frequency.get(term) ?? 0) + 1);
    }
  }
  return Object.freeze({
    document_count: documents.length,
    total_term_count,
    document_frequency,
  });
}

/**
 * Resolve a scorer by name.  `real` adapts to the analyzer module: when it
 * exports a statistics-aware scorer the benchmark uses it, otherwise it falls
 * back to the legacy term-frequency sum.
 */
export function resolveScorer(name, analyzer) {
  switch (name) {
    case "tfsum":
      return Object.freeze({ name, score: tfSum });
    case "bm25":
      return Object.freeze({
        name,
        score: (frequencies, length, queryTerms, statistics) =>
          bm25(frequencies, length, queryTerms, statistics, {
            controlled_terms: new Set(analyzer.READABLE_SEARCH_DECISION_TERM_FAMILY ?? []),
          }),
      });
    case "real": {
      if (typeof analyzer.readableSearchScoreV2 === "function") {
        return Object.freeze({
          name: `real:${analyzer.READABLE_SEARCH_SCORER_ID ?? "v2"}`,
          score: (frequencies, length, queryTerms, statistics) =>
            analyzer.readableSearchScoreV2(frequencies, length, queryTerms, statistics),
        });
      }
      if (typeof analyzer.readableSearchScore === "function") {
        return Object.freeze({
          name: "real:tfsum-v3",
          score: (frequencies, _length, queryTerms) =>
            analyzer.readableSearchScore(frequencies, queryTerms),
        });
      }
      throw new Error("analyzer exports no known scorer");
    }
    default:
      throw new Error(`unknown scorer ${name}; use tfsum, bm25 or real`);
  }
}

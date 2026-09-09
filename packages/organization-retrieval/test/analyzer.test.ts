import { describe, expect, it } from 'vitest';
import {
  analyzeReadableSearchDocument,
  analyzeReadableSearchQuery,
  compareReadableSearchCandidates,
  READABLE_SEARCH_SCORE_SCALE,
  readableSearchDocumentLength,
  readableSearchInverseDocumentFrequency,
  readableSearchScoreV2,
  type ReadableSearchCorpusStatistics,
} from '../src/application/analyzer.js';

function statisticsOf(documents: readonly ReadonlyMap<string, number>[]): ReadableSearchCorpusStatistics {
  const document_frequency = new Map<string, number>();
  let total_term_count = 0;
  for (const document of documents) {
    total_term_count += readableSearchDocumentLength(document);
    for (const term of document.keys()) document_frequency.set(term, (document_frequency.get(term) ?? 0) + 1);
  }
  return { document_count: documents.length, total_term_count, document_frequency };
}

describe('readable-search analyzer', () => {
  it('uses Unicode alphanumeric runs, lowercases, and preserves query first occurrence', () => {
    expect(analyzeReadableSearchQuery('Café CAFÉ １２3, x')).toEqual(['café', '１２3', 'x']);
    const document = analyzeReadableSearchDocument('Café café １２3 café');
    expect([...document.entries()]).toEqual([['café', 3], ['１２3', 1]]);
    expect(readableSearchDocumentLength(document)).toBe(4);
    const statistics = statisticsOf([document, analyzeReadableSearchDocument('other words')]);
    const score = readableSearchScoreV2(document, 4, ['café', 'missing', '１２3'], statistics);
    expect(Number.isInteger(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
    expect(readableSearchScoreV2(document, 4, ['missing'], statistics)).toBe(0);
  });

  it('weights rare terms above common ones and saturates repeated terms', () => {
    const documents = [
      analyzeReadableSearchDocument('common rare'),
      analyzeReadableSearchDocument('common common'),
      analyzeReadableSearchDocument('common'),
      analyzeReadableSearchDocument('common other'),
      analyzeReadableSearchDocument('common common common common common common common common'),
    ];
    const statistics = statisticsOf(documents);
    const score = (index: number, terms: readonly string[]) =>
      readableSearchScoreV2(documents[index]!, readableSearchDocumentLength(documents[index]!), terms, statistics);
    expect(readableSearchInverseDocumentFrequency(1, 5)).toBeGreaterThan(readableSearchInverseDocumentFrequency(5, 5));
    expect(readableSearchInverseDocumentFrequency(5, 5)).toBeGreaterThan(0);
    expect(readableSearchInverseDocumentFrequency(0, 5)).toBe(0);
    // One rare match beats a doubled common match, which the old tf-sum tied.
    expect(score(0, ['common', 'rare'])).toBeGreaterThan(score(1, ['common', 'rare']));
    // Eight repeats of a term score well under eight times one occurrence.
    expect(score(4, ['common'])).toBeLessThan(score(2, ['common']) * 3);
    // Scores are fixed-point integers.
    for (const index of [0, 1, 2, 3, 4]) expect(Number.isInteger(score(index, ['common', 'rare']))).toBe(true);
  });

  it('scores the closed decision family with a constant unit weight instead of idf', () => {
    const documents = [
      analyzeReadableSearchDocument('We approved the launch.', 'decision'),
      analyzeReadableSearchDocument('We approved the budget.', 'decision'),
      analyzeReadableSearchDocument('We approved the hire.', 'decision'),
    ];
    const statistics = statisticsOf(documents);
    const length = readableSearchDocumentLength(documents[0]!);
    const decision = readableSearchScoreV2(documents[0]!, length, ['decision'], statistics);
    const approved = readableSearchScoreV2(documents[0]!, length, ['approved'], statistics);
    // Every document carries both terms. IDF alone would make both tiny; the
    // controlled category keeps a full unit of weight.
    expect(decision).toBeGreaterThan(approved);
    expect(decision).toBeLessThanOrEqual(READABLE_SEARCH_SCORE_SCALE * 2.2);
  });

  it('uses only the supplied statistics, so scope is decided by the caller', () => {
    const document = analyzeReadableSearchDocument('shared private');
    const narrow = statisticsOf([document, analyzeReadableSearchDocument('shared')]);
    const wide = statisticsOf([document, analyzeReadableSearchDocument('shared'), analyzeReadableSearchDocument('private'), analyzeReadableSearchDocument('private')]);
    const length = readableSearchDocumentLength(document);
    expect(readableSearchScoreV2(document, length, ['private'], narrow)).toBeGreaterThan(
      readableSearchScoreV2(document, length, ['private'], wide),
    );
  });

  it('expands only the closed decision word family for query recall', () => {
    expect(analyzeReadableSearchQuery('What was decided?')).toEqual([
      'what',
      'was',
      'decided',
      'decision',
      'decisions',
      'decide',
      'deciding',
    ]);
    expect(analyzeReadableSearchQuery('decision deciding')).toEqual([
      'decision',
      'deciding',
      'decisions',
      'decide',
      'decided',
    ]);
    expect(analyzeReadableSearchQuery('decisive')).toEqual(['decisive']);
    expect(analyzeReadableSearchQuery(`decision ${Array.from({ length: 31 }, (_, index) => `term${index}`).join(' ')}`)).toHaveLength(36);
    expect(() => analyzeReadableSearchQuery(`decision ${Array.from({ length: 32 }, (_, index) => `term${index}`).join(' ')}`)).toThrow(
      'one through thirty-two',
    );
  });

  it('adds the controlled decision category only for admitted decision items', () => {
    expect([...analyzeReadableSearchDocument('We approved the launch for Tuesday.', 'decision')]).toEqual([
      ['we', 1],
      ['approved', 1],
      ['the', 1],
      ['launch', 1],
      ['for', 1],
      ['tuesday', 1],
      ['decision', 1],
    ]);
    expect([...analyzeReadableSearchDocument('We approved the launch for Tuesday.', 'action')]).not.toContainEqual([
      'decision',
      1,
    ]);
  });

  it('rejects an empty, non-NFC, or over-wide query while documents omit wide tokens', () => {
    expect(() => analyzeReadableSearchQuery('...')).toThrow('one through thirty-two');
    expect(() => analyzeReadableSearchQuery('e\u0301')).toThrow('must be NFC');
    expect(() => analyzeReadableSearchQuery('a'.repeat(65))).toThrow('exceeds 64');
    expect([...analyzeReadableSearchDocument(`keep ${'a'.repeat(65)}`).entries()]).toEqual([['keep', 1]]);
  });

  it('orders candidates only by score, position, atom order, and atom ID', () => {
    const rows = [
      { score: 1, log_position: 2, atom_order: 0, atom_id: 'sha256:b' },
      { score: 2, log_position: 1, atom_order: 1, atom_id: 'sha256:z' },
      { score: 2, log_position: 1, atom_order: 0, atom_id: 'sha256:a' },
      { score: 2, log_position: 1, atom_order: 0, atom_id: 'sha256:0' },
    ];
    expect([...rows].sort(compareReadableSearchCandidates).map((row) => row.atom_id)).toEqual([
      'sha256:0', 'sha256:a', 'sha256:z', 'sha256:b',
    ]);
  });
});

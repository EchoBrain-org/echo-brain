import { describe, expect, it } from 'vitest';
import {
  analyzeReadableSearchDocument,
  analyzeReadableSearchQuery,
  compareReadableSearchCandidates,
  readableSearchScore,
} from '../src/application/analyzer.js';

describe('readable-search analyzer', () => {
  it('uses Unicode alphanumeric runs, lowercases, and preserves query first occurrence', () => {
    expect(analyzeReadableSearchQuery('Café CAFÉ １２3, x')).toEqual(['café', '１２3', 'x']);
    const document = analyzeReadableSearchDocument('Café café １２3 café');
    expect([...document.entries()]).toEqual([['café', 3], ['１２3', 1]]);
    expect(readableSearchScore(document, ['café', 'missing', '１２3'])).toBe(4);
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
  });

  it('rejects an empty, non-NFC, or over-wide query while documents omit wide tokens', () => {
    expect(() => analyzeReadableSearchQuery('...')).toThrow('one through sixteen');
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

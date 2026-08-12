import { ReadableSearchValidationError } from './contracts.js';

export const MAXIMUM_QUERY_TERMS = 16;
export const MAXIMUM_TERM_UTF8_BYTES = 64;

function assertNfc(value: string, label: string): void {
  if (value !== value.normalize('NFC')) {
    throw new ReadableSearchValidationError(`${label} must be NFC`);
  }
}

function normalizedTerms(value: string): readonly string[] {
  const runs = value.match(/[\p{L}\p{N}]+/gu) ?? [];
  return runs.map((run) => run.toLowerCase().normalize('NFC'));
}

export function analyzeReadableSearchQuery(query: string): readonly string[] {
  assertNfc(query, 'query');
  const unique: string[] = [];
  const observed = new Set<string>();
  for (const term of normalizedTerms(query)) {
    if (Buffer.byteLength(term, 'utf8') > MAXIMUM_TERM_UTF8_BYTES) {
      throw new ReadableSearchValidationError('query term exceeds 64 UTF-8 bytes');
    }
    if (!observed.has(term)) {
      observed.add(term);
      unique.push(term);
    }
  }
  if (unique.length === 0 || unique.length > MAXIMUM_QUERY_TERMS) {
    throw new ReadableSearchValidationError('query must contain from one through sixteen unique terms');
  }
  return Object.freeze(unique);
}

export function analyzeReadableSearchDocument(text: string): ReadonlyMap<string, number> {
  assertNfc(text, 'document text');
  const frequencies = new Map<string, number>();
  for (const term of normalizedTerms(text)) {
    if (Buffer.byteLength(term, 'utf8') > MAXIMUM_TERM_UTF8_BYTES) continue;
    frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  }
  return frequencies;
}

export interface ReadableSearchCandidateOrder {
  readonly score: number;
  readonly log_position: number;
  readonly atom_order: number;
  readonly atom_id: string;
}

export function readableSearchScore(
  frequencies: ReadonlyMap<string, number>,
  queryTerms: readonly string[],
): number {
  return queryTerms.reduce((score, term) => score + (frequencies.get(term) ?? 0), 0);
}

export function compareReadableSearchCandidates(
  left: ReadableSearchCandidateOrder,
  right: ReadableSearchCandidateOrder,
): number {
  if (left.score !== right.score) return right.score - left.score;
  if (left.log_position !== right.log_position) return right.log_position - left.log_position;
  if (left.atom_order !== right.atom_order) return left.atom_order - right.atom_order;
  return Buffer.compare(Buffer.from(left.atom_id), Buffer.from(right.atom_id));
}

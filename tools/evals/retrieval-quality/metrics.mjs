/** Standard ranked-retrieval metrics over one query's ordered result ids. */

export function reciprocalRank(ranked, relevant, k) {
  for (let index = 0; index < Math.min(k, ranked.length); index += 1) {
    if (relevant.has(ranked[index])) return 1 / (index + 1);
  }
  return 0;
}

export function recallAt(ranked, relevant, k) {
  if (relevant.size === 0) return 0;
  let hits = 0;
  for (let index = 0; index < Math.min(k, ranked.length); index += 1) {
    if (relevant.has(ranked[index])) hits += 1;
  }
  return hits / relevant.size;
}

/** Binary-relevance nDCG@k with the standard log2 discount. */
export function ndcgAt(ranked, relevant, k) {
  if (relevant.size === 0) return 0;
  let dcg = 0;
  for (let index = 0; index < Math.min(k, ranked.length); index += 1) {
    if (relevant.has(ranked[index])) dcg += 1 / Math.log2(index + 2);
  }
  let ideal = 0;
  for (let index = 0; index < Math.min(k, relevant.size); index += 1) {
    ideal += 1 / Math.log2(index + 2);
  }
  return dcg / ideal;
}

export function mean(values) {
  if (values.length === 0) return 0;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

export function percentile(sortedValues, fraction) {
  if (sortedValues.length === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * sortedValues.length));
  return sortedValues[rank - 1];
}

export function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

/** Request-local retrieval observations. No provider payload is stored here. */
export interface AskResearchObservationV1 {
  readonly operation: 'search' | 'list';
  readonly fingerprint: string;
  /** False for an error, availability notice, truncated search or unfinished list. */
  readonly complete: boolean;
}

export interface AskResearchNeedV1 {
  readonly need: string;
  readonly status: 'open' | 'found' | 'not_found';
  readonly evidence: readonly string[];
  readonly observations_before: number;
}

/**
 * The model proposes a completion; only observed reads can support it. This
 * checks that research happened, not semantic relevance: the model still
 * chooses queries/items and the writer checks whether their text answers.
 * A failed call or an unfinished inventory is never evidence of absence.
 */
export function askResearchCompletionProblemsV1(
  parts: readonly { readonly needs: readonly AskResearchNeedV1[] }[],
  observations: readonly AskResearchObservationV1[],
  citable: (id: string) => boolean,
): readonly string[] {
  if (parts.length === 0) return ['no parts were written'];
  const problems: string[] = [];
  for (const [index, part] of parts.entries()) {
    for (const need of part.needs) {
      const label = `part ${index + 1} need "${need.need}"`;
      if (need.status === 'open') problems.push(`${label} is still open`);
      else if (need.status === 'found' && !need.evidence.some(citable)) problems.push(`${label} is found but cites no item whose full text you have read`);
      else if (need.status === 'not_found') {
        const completed = observations.slice(need.observations_before).filter(value => value.complete);
        const searches = new Set(completed.filter(value => value.operation === 'search').map(value => value.fingerprint));
        if (searches.size < 2 && !completed.some(value => value.operation === 'list')) {
          problems.push(`${label} is not_found after fewer than two completed searches or a completed list`);
        }
      }
    }
  }
  return problems;
}

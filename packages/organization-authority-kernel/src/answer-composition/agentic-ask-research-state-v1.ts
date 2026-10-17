import { agenticNeedSupportV1, type AgenticListIdV1, type AgenticListMemberRefV1 } from "./agentic-list-evidence-v1.js";

/** Request-local retrieval observations. No provider payload is stored here. */
export interface AskResearchObservationV1 {
  readonly operation: 'search' | 'list';
  readonly fingerprint: string;
  /** False for an error, availability notice, truncated search or unfinished list. */
  readonly complete: boolean;
}

export interface AskResearchNeedV1 {
  /** The need's id the planner sees ("N3"), so a rejected finish names it. */
  readonly id?: string;
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
 * Without the list tool (a search-only brief) the problems never name list.
 */
export function askResearchCompletionProblemsV1(
  parts: readonly { readonly needs: readonly AskResearchNeedV1[] }[],
  observations: readonly AskResearchObservationV1[],
  citable: (id: string) => boolean,
  list = true,
): readonly string[] {
  return completionProblems(parts, observations, list, (need, label) =>
    need.evidence.some(citable) ? [] : [`${label} is found but cites no item whose full text you have read`]);
}

/** A list research read in a question's request, as the finish check sees it (ADR-0041). */
export interface AskResearchListV1 {
  readonly id: AgenticListIdV1;
  /** No next page and every fetched row is a member: research cannot read further. */
  readonly ended: boolean;
  /** The list's normalized args: repeating list with them reads its next page. */
  readonly args: Readonly<Record<string, string>>;
  /** Its members' item ids, in list order. */
  readonly members: readonly string[];
}

/**
 * The finish check for a question goal (Ask, ADR-0041). A found need's
 * evidence divides into list support (lists cited by id, the list of a cited
 * member row research never read in full, or a list two or more of whose
 * members it cites) and content (items read in full). A need with list support is checked against its lists: one that can
 * still be read further refuses the finish ("keep reading the list"); one
 * that cannot (truncated, unavailable or an unverified end) is accepted, and
 * the answer says "at least". A need without list support still needs at
 * least one cited item read in full. The other rules are the task goal's.
 *
 * Member rows alone are not support: a need must also cite a list by its id,
 * or an item read in full. Otherwise a content need ("when is launch?") that
 * cites a list's row would finish before research read the item, and the
 * writer, which never sees a row's text, could not answer it. The refusal
 * names both ways on: cite the list for which items exist, or open the items.
 *
 * `member_of` says which list member an item is, or is part of (an opened
 * page's section is its page: agenticListMembershipV1); by default an item
 * belongs only to the lists whose members include it.
 */
export function askQuestionCompletionProblemsV1(
  parts: readonly { readonly needs: readonly AskResearchNeedV1[] }[],
  observations: readonly AskResearchObservationV1[],
  lists: readonly AskResearchListV1[],
  full: (id: string) => boolean,
  list = true,
  member_of: (id: string) => AgenticListMemberRefV1 | undefined = id => {
    const holder = lists.find(value => value.members.includes(id));
    return holder === undefined ? undefined : { list: holder.id, member: id };
  },
): readonly string[] {
  const byId = new Map(lists.map(value => [value.id, value]));
  const lookup = { list: (id: AgenticListIdV1) => byId.has(id), full, member_of };
  return completionProblems(parts, observations, list, (need, label) => {
    const support = agenticNeedSupportV1(need.evidence, lookup);
    const named = support.lists.some(id => need.evidence.some(cited => cited === id));
    if (support.content.length === 0 && !named) {
      const unread = `${label} is found but cites no item whose full text you have read`;
      return [support.lists.length === 0 ? unread : `${unread}: cite ${support.lists.join(" or ")} for which items exist, or open the items for what they say`];
    }
    return support.lists.flatMap(id => {
      const state = byId.get(id)!;
      return state.ended ? [] : [`${label}: list ${id} is unfinished: keep reading the list (repeat list with ${JSON.stringify(state.args)})`];
    });
  });
}

function completionProblems(
  parts: readonly { readonly needs: readonly AskResearchNeedV1[] }[],
  observations: readonly AskResearchObservationV1[],
  list: boolean,
  found: (need: AskResearchNeedV1, label: string) => readonly string[],
): readonly string[] {
  if (parts.length === 0) return ['no parts were written'];
  const problems: string[] = [];
  for (const [index, part] of parts.entries()) {
    for (const need of part.needs) {
      const label = `part ${index + 1} need ${need.id === undefined ? "" : `${need.id} `}"${need.need}"`;
      if (need.status === 'open') problems.push(`${label} is still open`);
      else if (need.status === 'found') problems.push(...found(need, label));
      else if (need.status === 'not_found') {
        const completed = observations.slice(need.observations_before).filter(value => value.complete);
        const searches = new Set(completed.filter(value => value.operation === 'search').map(value => value.fingerprint));
        if (searches.size < 2 && !completed.some(value => value.operation === 'list')) {
          problems.push(`${label} is not_found after fewer than two completed searches${list ? " or a completed list" : ""}`);
        }
      }
    }
  }
  return problems;
}

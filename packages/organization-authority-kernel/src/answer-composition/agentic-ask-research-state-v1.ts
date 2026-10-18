import { agenticNeedReadsListV1, parseAgenticListIdV1, type AgenticListIdV1 } from "./agentic-list-evidence-v1.js";
import type { AgenticResearchNeedKindV1 } from "./agentic-research-v1.js";

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
  /** Ask's declared kind (ADR-0041); a need without one is content. */
  readonly kind?: AgenticResearchNeedKindV1;
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
    need.status !== 'found' || need.evidence.some(citable) ? [] : [`${label} is found but cites no item whose full text you have read`]);
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

/** What a refusal adds with the list tool: what each kind of support is, never a change of kind (ADR-0041). */
const CONTENT_HINT = ": a list shows which items exist and each member's title, dates, status and owner, never what an item says; open the items for what they say";

/**
 * The finish check for a question goal (Ask, ADR-0041), from each settled need's declared kind alone. A need code
 * reads a list for (agenticNeedReadsListV1) cites, by its id, a list research read; otherwise it is refused once with
 * the ids of the lists that hold what it cites (`member_in`: an opened page's section is its page), which word the
 * refusal and never support the need. A found which_items need waits for each list it cites, or would have cited, to
 * end ("keep reading the list"); one that cannot be read further (truncated, unavailable or an unverified end) is
 * accepted, and the answer says "at least". A found which_say or content need cites an item read in full, as before
 * ADR-0041; a which_say need never waits for its list's end, and a content need's list ids carry no meaning. The
 * not_found and open rules are the task goal's, for every kind. By default an item is only itself.
 */
export function askQuestionCompletionProblemsV1(
  parts: readonly { readonly needs: readonly AskResearchNeedV1[] }[],
  observations: readonly AskResearchObservationV1[],
  lists: readonly AskResearchListV1[],
  citable: (id: string) => boolean,
  list = true,
  member_in: (list: AgenticListIdV1, id: string) => string | undefined = (id, item) => lists.find(value => value.id === id)?.members.includes(item) === true ? item : undefined,
): readonly string[] {
  return completionProblems(parts, observations, list, (need, label) => {
    const kind = need.kind ?? "content";
    // A found which_say or content need needs text read in full.
    const read = need.status !== "found" || kind === "which_items" || need.evidence.some(citable) ? [] : [`${label} is found but cites no item whose full text you have read${list ? CONTENT_HINT : ""}`];
    if (!agenticNeedReadsListV1(need)) return read;
    const cited = lists.filter(value => need.evidence.some(id => parseAgenticListIdV1(id) === value.id));
    const holders = cited.length > 0 ? [] : lists.filter(value => need.evidence.some(id => member_in(value.id, id) !== undefined));
    const unlisted = cited.length > 0 ? [] : [`${label} cites no list: cite the id of the list that holds its items${holders.length === 0 ? " (from lists), or list them first" : ` (${holders.map(value => value.id).join(" or ")})`}`];
    // Only which_items waits for its lists' end.
    const unfinished = kind !== "which_items" ? [] : [...cited, ...holders].flatMap(value => value.ended ? [] : [`${label}: list ${value.id} is unfinished: keep reading the list (repeat list with ${JSON.stringify(value.args)})`]);
    return [...unlisted, ...unfinished, ...read];
  });
}

/** The open and not_found rules every goal shares; each settled need then goes to its goal's own rule. */
function completionProblems(
  parts: readonly { readonly needs: readonly AskResearchNeedV1[] }[],
  observations: readonly AskResearchObservationV1[],
  list: boolean,
  settled: (need: AskResearchNeedV1, label: string) => readonly string[],
): readonly string[] {
  if (parts.length === 0) return ['no parts were written'];
  const problems: string[] = [];
  for (const [index, part] of parts.entries()) {
    for (const need of part.needs) {
      const label = `part ${index + 1} need ${need.id === undefined ? "" : `${need.id} `}"${need.need}"`;
      if (need.status === 'open') { problems.push(`${label} is still open`); continue; }
      if (need.status === 'not_found') {
        const completed = observations.slice(need.observations_before).filter(value => value.complete);
        const searches = new Set(completed.filter(value => value.operation === 'search').map(value => value.fingerprint));
        if (searches.size < 2 && !completed.some(value => value.operation === 'list')) {
          problems.push(`${label} is not_found after fewer than two completed searches${list ? " or a completed list" : ""}`);
        }
      }
      problems.push(...settled(need, label));
    }
  }
  return problems;
}

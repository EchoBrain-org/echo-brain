/**
 * Bindings turn answer-key references into the citations a research run
 * starts from: the approved-record citations found on staging after the
 * meetings are approved.
 */

/** A case's start request cannot be built: a citation is not bound, or cannot start research. The runner records it and goes on. */
export class CaseNotStartableError extends Error {
  constructor(message) { super(message); this.name = "CaseNotStartableError"; }
}

export function meetingCitation(bindings, meetingId, item) {
  const citations = bindings.meetings?.[meetingId]?.[item];
  if (!Array.isArray(citations) || citations.length === 0) throw new CaseNotStartableError(`no ${item} citation bound for meeting ${meetingId}; run bindings after approving it, or fill it in by hand`);
  return citations[0];
}

/** The most items an evidence search with words returns (validatePersonEvidenceSearchRequestV1). */
const SEARCH_LIMIT = 10;
const RECORD_KINDS = ["decision", "action", "rationale"];

/**
 * Finds each approved meeting's record citations by searching its title in
 * the project, keeping only items whose label carries that title. Each kind
 * is its own search, so under the cap one kind's items never crowd out
 * another's.
 */
export async function discoverMeetings(client, additions, projectId) {
  const restricted = additions.restricted_project.name;
  const meetings = {};
  const missing = [];
  for (const meeting of additions.meetings.filter(value => value.project !== restricted)) {
    const title = meeting.title.toLowerCase();
    const found = {};
    for (const kind of RECORD_KINDS) {
      const desk = await client.evidenceSearch({ schema_version: 1, query: meeting.title, kinds: [kind], limit: SEARCH_LIMIT, project_id: projectId });
      found[kind] = desk.items.filter(item => item.kind === kind && typeof item.label === "string" && item.label.toLowerCase().includes(title)).map(item => item.citation);
    }
    if (RECORD_KINDS.every(kind => found[kind].length === 0)) { missing.push(meeting.id); continue; }
    meetings[meeting.id] = found;
  }
  return { meetings, missing };
}

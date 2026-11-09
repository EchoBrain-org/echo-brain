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

/** Each record kind a binding holds, and the section of the cited record (`PersonCitedRecordV1`) that lists it. */
const RECORD_SECTIONS = { decision: "decisions", action: "actions", rationale: "rationales" };

/**
 * Finds each approved meeting's record citations as the product reads them.
 * The project's list (`person list --project`) names every approved meeting
 * in it by title. Each meeting whose title carries the dataset meeting's is
 * read as Ask cites it (`person records --record-sha256 <digest> --brief`):
 * every decision, action and rationale with its atom id, under the record's
 * policy. Each kind keeps the record's order, newest record first.
 */
export async function discoverMeetings(client, additions, projectId) {
  const { personCitedRecordV1 } = await import("@echo-brain/organization-api");
  const listed = [];
  let cursor;
  do {
    const page = await client.list({ schema_version: 1, project_id: projectId, ...(cursor === undefined ? {} : { cursor }) });
    listed.push(...page.items.filter(item => item.kind === "meeting"));
    cursor = page.next_cursor ?? undefined;
  } while (cursor !== undefined);
  const restricted = additions.restricted_project.name;
  const meetings = {};
  const missing = [];
  for (const meeting of additions.meetings.filter(value => value.project !== restricted)) {
    const title = meeting.title.toLowerCase();
    const found = Object.fromEntries(Object.keys(RECORD_SECTIONS).map(kind => [kind, []]));
    for (const row of listed.filter(item => item.title.toLowerCase().includes(title))) {
      const digest = row.ref.slice("meeting:".length);
      const record = (await client.records(undefined, undefined, digest)).records.find(value => value.record_sha256 === digest);
      if (record === undefined) continue;
      const cited = personCitedRecordV1(record);
      for (const [kind, section] of Object.entries(RECORD_SECTIONS)) {
        found[kind].push(...cited[section].items.map(item => ({ kind: "approved_record", atom_id: item.atom_id, record_sha256: cited.record_sha256, policy_id: cited.policy_id })));
      }
    }
    if (Object.values(found).every(citations => citations.length === 0)) { missing.push(meeting.id); continue; }
    meetings[meeting.id] = found;
  }
  return { meetings, missing };
}

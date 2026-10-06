import { createHash } from "node:crypto";

/**
 * Bindings turn answer-key references into the citations a research run
 * starts from: Jira and Confluence identities from the founder's export, and
 * approved-record citations found on staging after the meetings are approved.
 */
const EMPTY_SHA256 = `sha256:${createHash("sha256").update("").digest("hex")}`;

/** Site, cloud id and THERM issue ids from the export's `source-data.json`. */
export function exportBindings(sourceData, project = "THERM") {
  if (typeof sourceData?.site !== "string" || typeof sourceData?.cloudId !== "string") throw new Error("export source data has no site or cloud id");
  const site = new URL(sourceData.site).origin;
  const issues = (sourceData.jira_batches ?? []).flatMap(batch => batch.issues ?? []);
  const tickets = Object.fromEntries(issues.filter(issue => typeof issue.key === "string" && issue.key.startsWith(`${project}-`)).map(issue => [issue.key, String(issue.id)]));
  if (Object.keys(tickets).length === 0) throw new Error(`export has no ${project} issues`);
  return { site, cloud_id: sourceData.cloudId, tickets };
}

/** An earlier ticket citation; the reader re-reads it fresh, so its digest names no text. */
export function ticketCitation(bindings, key) {
  const id = bindings.tickets[key];
  if (id === undefined) throw new Error(`no Jira id bound for ${key}`);
  return { kind: "ticket", tool_id: "jira", external_scope_id: bindings.cloud_id, ticket_id: id, permalink: `${bindings.site}/browse/${key}`, text_sha256: EMPTY_SHA256 };
}

export function pageCitation(bindings, pageId) {
  return { kind: "page", tool_id: "confluence", external_scope_id: bindings.cloud_id, page_id: pageId, section_id: "s1", version: "1",
    permalink: `${bindings.site}/wiki/pages/viewpage.action?pageId=${pageId}`, text_sha256: EMPTY_SHA256 };
}

export function meetingCitation(bindings, meetingId, item) {
  const citations = bindings.meetings?.[meetingId]?.[item];
  if (!Array.isArray(citations) || citations.length === 0) throw new Error(`no ${item} citation bound for meeting ${meetingId}; run bindings after approving it, or fill it in by hand`);
  return citations[0];
}

/** The citation a key reference starts from. Transcripts are not starting evidence in v1. */
export function citationFor(bindings, ref) {
  if (ref.ticket !== undefined) return ticketCitation(bindings, ref.ticket);
  if (ref.page !== undefined) return pageCitation(bindings, ref.page);
  if (ref.meeting !== undefined && ref.item !== "transcript") return meetingCitation(bindings, ref.meeting, ref.item);
  throw new Error(`reference ${JSON.stringify(ref)} cannot start research`);
}

/**
 * Finds each approved meeting's record citations by searching its title in
 * the project, keeping only items whose label carries that title.
 */
export async function discoverMeetings(client, additions, projectId) {
  const restricted = additions.restricted_project.name;
  const meetings = {};
  const missing = [];
  for (const meeting of additions.meetings.filter(value => value.project !== restricted)) {
    const desk = await client.evidenceSearch({ schema_version: 1, query: meeting.title, kinds: ["decision", "action", "rationale"], limit: 50, project_id: projectId });
    const title = meeting.title.toLowerCase();
    const items = desk.items.filter(item => typeof item.label === "string" && item.label.toLowerCase().includes(title));
    if (items.length === 0) { missing.push(meeting.id); continue; }
    meetings[meeting.id] = Object.fromEntries(["decision", "action", "rationale"].map(kind => [kind, items.filter(item => item.kind === kind).map(item => item.citation)]));
  }
  return { meetings, missing };
}

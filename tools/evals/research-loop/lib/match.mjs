/**
 * Matches items in a research result (eval view) to answer-key references.
 * References name items by citation, never by request-local E-numbers.
 */

const lower = value => (typeof value === "string" ? value.toLowerCase() : "");

/** The Jira key a ticket item carries, from its permalink or its "KEY: summary" title. */
export function ticketKey(item) {
  const fromLink = /\/browse\/([A-Z][A-Z0-9]+-\d+)(?:$|[?#])/u.exec(item?.citation?.permalink ?? "");
  if (fromLink !== null) return fromLink[1];
  const fromTitle = /^([A-Z][A-Z0-9]+-\d+):/u.exec(item?.title ?? "");
  return fromTitle === null ? undefined : fromTitle[1];
}

function meetingTitle(meetings, id) {
  const meeting = meetings.get(id);
  if (meeting === undefined) throw new Error(`unknown meeting ${id}`);
  return lower(meeting.title);
}

/**
 * True when the item is the referenced evidence. A page matches by id; a
 * section, when named, must appear in the released section text or title.
 * Meeting records match by kind and meeting title; transcripts by title.
 */
export function itemMatches(item, ref, meetings) {
  if (ref.ticket !== undefined) return item.kind === "ticket" && ticketKey(item) === ref.ticket;
  if (ref.jira_project !== undefined) return item.kind === "ticket" && (ticketKey(item) ?? "").startsWith(`${ref.jira_project}-`);
  if (ref.page !== undefined) return item.kind === "page" && String(item.citation?.page_id ?? "") === ref.page;
  if (ref.meeting !== undefined) {
    const title = meetingTitle(meetings, ref.meeting);
    const label = lower(item.title);
    if (ref.item === "transcript") return label.startsWith("transcript:") && label.includes(title);
    return item.kind === ref.item && label.includes(title);
  }
  throw new Error(`unknown reference ${JSON.stringify(ref)}`);
}

/** Whether a matched page item carries the named section heading (text or title). */
export function sectionCovered(item, ref) {
  if (ref.section === undefined) return true;
  const section = lower(ref.section);
  return lower(item.text).includes(section) || lower(item.title).includes(section);
}

function sectionIndex(item) {
  const match = /^s(\d+)$/u.exec(String(item.citation?.section_id ?? ""));
  return match === null ? undefined : Number(match[1]);
}

/**
 * Items that carry a referenced page section. Confluence releases a page as
 * fixed-size text chunks, so a section is the chunk holding its heading and the
 * chunk after it; a page reference without a section is any item of the page.
 */
export function satisfying(items, ref, meetings) {
  const matched = matching(items, ref, meetings);
  if (ref.page === undefined || ref.section === undefined) return matched;
  const starts = matched.filter(item => sectionCovered(item, ref));
  const accepted = new Set(starts.flatMap(item => {
    const index = sectionIndex(item);
    return index === undefined ? [`${item.citation?.version}:title`] : [`${item.citation?.version}:${index}`, `${item.citation?.version}:${index + 1}`];
  }));
  return matched.filter(item => starts.includes(item) || accepted.has(`${item.citation?.version}:${sectionIndex(item)}`));
}

export function matching(items, ref, meetings) {
  return items.filter(item => itemMatches(item, ref, meetings));
}

export function meetingIndex(additions) {
  return new Map(additions.meetings.map(meeting => [meeting.id, meeting]));
}

/** Distinctive text from restricted meetings; any trace of it in a run is a leak. */
export function leakMarkers(additions) {
  return Array.isArray(additions.restricted_project?.leak_markers) ? additions.restricted_project.leak_markers : [];
}

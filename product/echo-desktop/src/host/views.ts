// Turns the person client's validated JSON output into the token-free view
// models of ../shared/protocol.ts. The client checks each reply with the
// organization API's validators before printing it; each view takes what it
// printed through the same validator, and copies explicitly only the fields
// the renderer needs, so nothing else the client prints can reach it.
import type {
  Account, Answer, AnswerSource, AppStatus, ApprovedRecord, AskCheckResult, AskRead, AskScope, AskSearched, AskStep, Audience, ConnectedTools,
  CreatedProject, DocumentSummary, Employee, Employees, Extraction, Failure, InvitationSaved, ItemRef, ListItem, ListPage, ListScope, Match, Matches, MemberPage, Opened,
  ProjectActivity, ProjectChange, ProjectConfluenceMapping, ConfluenceSpacesPage, ProjectJiraMapping, ProjectPage, ProjectSettingsReceipt, ProjectSummary, Receipt, RecordItem, RecordPolicy, RecordRef,
  RecordSection, SourceEvidence, SourceRef, ToolAttempt, ToolAttemptStatus, Visibility, WriteStatus, HomeView, OpenItemView, OpenItemsView,
} from '../shared/protocol.js';
import { canonicalSha256 } from '@echo-brain/federation-protocol';
import {
  PERSON_HAND_IN_MEETING_ID_V1, validatePersonMeetingResultV2,
  validateOrganizationDirectoryV1, validateOrganizationPersonToolsV4, validatePersonAskCheckV1, validatePersonAskProgressLineV3, validatePersonAskProgressResultLineV3,
  validatePersonDocumentAssociationReceiptV1, validatePersonListResponseV1, validatePersonOpenResponseV1, validatePersonProjectActivityV1, validatePersonSourceEvidenceV1,
  validatePersonUploadSearchResultV2, validatePersonUploadSearchResultV3, validateProjectContextSearchResultV2, validateProjectCreateReceiptV1, validateProjectListV2,
  validateProjectMembersV1, validateProjectMutationReceiptV1, validateProjectSettingsReceiptV1, validateProjectSummaryV2,
  type PersonAnswerCitationV8, type PersonAskReceiptRowV3, type PersonDocumentMediaTypeV1, type PersonListRowV1, type PersonListVisibilityV1, type PersonOpenDocumentV1, type PersonOpenImportedMeetingV1,
  type PersonOpenItemV1, type PersonOpenMeetingAtomV1, type PersonOpenMeetingV1, type PersonOpenNoteV1, type PersonRunsResultsV1, type ProjectSummaryV2,
} from '@echo-brain/organization-api';
import { externalSourcePermalink } from '../shared/protocol.js';

type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new ViewError();
  return value as Json;
}
function text(value: unknown): string {
  if (typeof value !== 'string') throw new ViewError();
  return value;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new ViewError();
  return value;
}

/** Output that does not have the shape the client promises. */
export class ViewError extends Error {
  constructor() { super('invalid_output'); }
}

/** Nothing where something was asked for: the Authority no longer shows it to this person. */
export class NotReadable extends Error {
  constructor() { super('not_found'); }
}

/** `{ ok: true, result }` wrapper used by ask, ask-source and documents. */
export function unwrap(raw: unknown): unknown {
  const value = object(raw);
  if (value.ok !== true) throw new ViewError();
  return value.result;
}

/** What the client printed, through the API validator it was checked with before printing; anything else is not its output. */
function validated<T>(validate: (value: unknown) => T, raw: unknown): T {
  try { return validate(raw); } catch { throw new ViewError(); }
}

/** The account signed in, if any; `now` is the host's clock, for how long the weekly sign-in has left. */
export function statusView(raw: unknown, now: number): AppStatus {
  const value = object(raw);
  if (value.kind !== 'echo-person-client-status-v1') throw new ViewError();
  const version = text(value.installed_version);
  if (value.signed_in !== true) {
    // Signed out by a refresh (the weekly sign-in, or a refused one): why, and the organization to sign in to again.
    const ended = value.session_ended !== null && typeof value.session_ended === 'object' ? value.session_ended as Json : {};
    const { reason, connected_authority: authority } = ended;
    return {
      signed_in: false, account: null, client_version: version,
      ...((reason === 'reauthentication_required' || reason === 'sign_in_required') && typeof authority === 'string'
        ? { session_ended: { reason, authority } } : {}),
    };
  }
  const role = value.membership_type;
  if (role !== 'owner' && role !== 'employee') throw new ViewError();
  const due = typeof value.hard_reauthentication_at === 'string' ? Date.parse(value.hard_reauthentication_at) : Number.NaN;
  const account: Account = {
    authority: text(value.connected_authority),
    membership_id: text(value.membership_id),
    display_name: text(value.display_name),
    role,
    ...(Number.isFinite(due) ? { sign_in_due: { at: new Date(due).toISOString(), in_ms: due - now } } : {}),
  };
  return { signed_in: true, account, client_version: version };
}

/** A project as the renderer has it. */
function projectSummary({ project_id, name, role, created_at, status }: ProjectSummaryV2): ProjectSummary {
  return { project_id, name, role, created_at, status };
}

export function projectPageView(raw: unknown): ProjectPage {
  const page = validated(validateProjectListV2, raw);
  return { items: page.items.map(projectSummary), next_cursor: page.next_cursor };
}

/** The project asked for, as it is now: your role in it may have changed. */
export function projectView(raw: unknown, projectId: string): ProjectSummary {
  const project = validated(validateProjectSummaryV2, raw);
  if (project.project_id !== projectId) throw new ViewError();
  return projectSummary(project);
}

/** A rename, archive/unarchive, or leave receipt, checked against exactly the request we sent. */
export function projectSettingsView(raw: unknown, requestId: string, projectId: string, operation: ProjectSettingsReceipt['operation']): ProjectSettingsReceipt {
  const receipt = validated(validateProjectSettingsReceiptV1, raw);
  if (receipt.request_id !== requestId || receipt.project_id !== projectId || receipt.operation !== operation) throw new ViewError();
  return { request_id: requestId, project_id: projectId, operation };
}

/** Who can read an item, in the list's three words: a project row says nothing more about its projects. */
const VISIBILITY: Readonly<Record<PersonListVisibilityV1, Visibility>> = { only_me: 'only-me', team: 'team', project: 'project' };

const MEDIA: Readonly<Record<PersonDocumentMediaTypeV1, DocumentSummary['type']>> = {
  'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'text/markdown': 'markdown', 'text/plain': 'text',
};

/** A ref's kind, and the id after it, as the API writes one: `note:ctx_…`, `document:doc_…`, `meeting:sha256:…`. */
function itemRef(ref: string): ItemRef {
  const at = ref.indexOf(':');
  return { kind: ref.slice(0, at) as ItemRef['kind'], id: ref.slice(at + 1) };
}

/** A row: its ref, title, when it was added, who can read it, and the names of your projects it is filed in. */
function listItem(row: PersonListRowV1): ListItem {
  const base = { ref: itemRef(row.ref), title: row.title, added_at: row.added_at, visibility: VISIBILITY[row.visibility], projects: row.projects.map(project => project.name) };
  if (row.kind === 'document') return { ...base, document: { type: MEDIA[row.media_type], size: row.size_bytes, extraction: row.extraction_state } };
  return row.kind === 'meeting' && row.meeting_date !== undefined ? { ...base, meeting_date: row.meeting_date } : base;
}

/** A list's scope as the API names it. */
const LIST_SCOPE = { 'only-me': 'only_me', project: 'project' } as const;

/**
 * One page of a list, only for the scope asked for. Nothing of its header
 * (who you are, your tools, your projects) crosses, and a row names your
 * projects it is filed in, never their ids.
 */
export function listView(raw: unknown, scope: ListScope): ListPage {
  const page = validated(validatePersonListResponseV1, unwrap(raw));
  const echoed = page.scope.kind === 'project' ? page.scope.project_id : undefined;
  if (page.scope.kind !== LIST_SCOPE[scope.kind] || echoed !== (scope.kind === 'project' ? scope.project_id : undefined)) throw new ViewError();
  return { items: page.items.map(listItem), next_cursor: page.next_cursor, meetings_held: page.notice === 'meetings_unavailable' };
}

/**
 * The item asked for, opened by its ref: a note's text, one page of a
 * document's text, or one page of a meeting's approved record. `first` says
 * the page was read without a cursor.
 */
export function openView(raw: unknown, ref: ItemRef, first: boolean): Opened {
  const opened = validated(validatePersonOpenResponseV1, unwrap(raw));
  if (opened.ref !== `${ref.kind}:${ref.id}` || !('item' in opened)) throw new ViewError();
  const item = listItem(opened.item);
  // Where an original is filed crosses here only, so the reader can add it to another project.
  const project_ids = opened.item.projects.map(project => project.project_id);
  const next = opened.next_cursor;
  switch (ref.kind) {
    case 'imported_meeting': {
      const { text } = opened as PersonOpenImportedMeetingV1;
      return { kind: 'imported_meeting', content: { context_id: ref.id, title: item.title, text, received_at: item.added_at, audience: item.visibility, project_ids }, next_cursor: next };
    }
    case 'note': {
      const { text } = opened as PersonOpenNoteV1;
      return { kind: 'note', content: { context_id: ref.id, title: item.title, text, received_at: item.added_at, audience: item.visibility, project_ids } };
    }
    case 'document': {
      const { filename, chunks } = opened as PersonOpenDocumentV1;
      const { type, size, extraction } = item.document!;
      return { kind: 'document', document: {
        document: {
          document_id: ref.id, title: item.title, filename, received_at: item.added_at, type, size, audience: item.visibility,
          extraction, project_ids,
        },
        chunks: chunks.map(chunk => ({ anchor: chunk.anchor.kind, start: chunk.anchor.start, text: chunk.text })), next_cursor: next,
      } };
    }
    case 'meeting':
      return { kind: 'meeting', record: meetingRecord(opened as PersonOpenMeetingV1, item, first), next_cursor: next };
  }
}

/** The original was written where the person chose, checked against its digest. The path stays behind. */
export function savedOriginalView(raw: unknown, documentId: string): null {
  const value = object(unwrap(raw));
  if (value.document_id !== documentId || typeof value.output_path !== 'string') throw new ViewError();
  return null;
}

/** One page of a project's members, only for that project: each one's id, name and role. */
export function membersView(raw: unknown, projectId: string): MemberPage {
  const page = validated(validateProjectMembersV1, raw);
  if (page.project_id !== projectId) throw new ViewError();
  return { items: page.items.map(({ membership_id, display_name, role }) => ({ membership_id, display_name, role })), next_cursor: page.next_cursor };
}

/** One page of the people in your organization, as `person directory` finds them: a name and a membership id each. */
export function directoryView(raw: unknown): MemberPage {
  const page = validated(validateOrganizationDirectoryV1, raw);
  return { items: page.items.map(({ membership_id, display_name }) => ({ membership_id, display_name })), next_cursor: page.next_cursor };
}

/** What a change's receipt says it did: its operation, and the member, note or document it names. */
function receiptOf(change: ProjectChange): readonly [string, string] {
  switch (change.kind) {
    case 'member-add':
    case 'member-set': return ['member_set', change.membership_id];
    case 'member-remove': return ['member_remove', change.membership_id];
    case 'associate':
    case 'dissociate': return [change.kind, change.context_id];
    case 'document-associate':
    case 'document-dissociate': return [change.kind.slice('document-'.length), change.document_id];
  }
}

/** The receipt for exactly the change that was sent: applied. */
export function changeView(raw: unknown, requestId: string, change: ProjectChange): null {
  const receipt = change.kind === 'document-associate' || change.kind === 'document-dissociate'
    ? validated(validatePersonDocumentAssociationReceiptV1, unwrap(raw)) : validated(validateProjectMutationReceiptV1, raw);
  const [operation, id] = receiptOf(change);
  const named = 'membership_id' in receipt ? receipt.membership_id : 'context_id' in receipt ? receipt.context_id : receipt.document_id;
  if (receipt.request_id !== requestId || receipt.project_id !== change.project_id || receipt.operation !== operation || named !== id) throw new ViewError();
  return null;
}

/** The receipt for exactly the create that was sent: its new project's id. */
export function createdView(raw: unknown, requestId: string): CreatedProject {
  const receipt = validated(validateProjectCreateReceiptV1, raw);
  if (receipt.request_id !== requestId) throw new ViewError();
  return { project_id: receipt.project_id };
}

const MEMBERSHIPS: ReadonlySet<string> = new Set<Employee['membership']>(['active', 'revoked']);
const INVITATIONS: ReadonlySet<string> = new Set<Employee['invitation']>(['pending', 'expired', 'redeemed', 'none']);

/** The owner's list of employees: each one's name, email and where they stand. */
export function employeesView(raw: unknown): Employees {
  const value = object(unwrap(raw));
  if (value.schema_version !== 1 || value.kind !== 'echo-clean-person-employee-roster-v1') throw new ViewError();
  return {
    items: list(value.employees).map(entry => {
      const employee = object(entry);
      const membership = text(employee.membership_status);
      const invitation = text(employee.invitation_state);
      if (!MEMBERSHIPS.has(membership) || !INVITATIONS.has(invitation)) throw new ViewError();
      return {
        email: text(employee.email), display_name: text(employee.display_name),
        membership: membership as Employee['membership'], invitation: invitation as Employee['invitation'],
      };
    }),
  };
}

/** An invitation written exactly where main said. The path stays behind. */
export function invitationView(raw: unknown, out: string): InvitationSaved {
  const value = object(raw);
  const expires = text(value.expires_at);
  if (value.ok !== true || value.output_path !== out || Number.isNaN(Date.parse(expires))) throw new ViewError();
  return { expires_at: expires };
}

/** Revoke access: the client confirms the membership ended. */
export function revokedView(raw: unknown): null {
  const value = object(raw);
  if (value.ok !== true || value.revoked !== true) throw new ViewError();
  return null;
}

function match({ context_id, title, excerpt, received_at }: Match): Match {
  return { context_id, title, excerpt, received_at };
}

/** A project's search results, only for the project that was searched. */
export function projectMatchesView(raw: unknown, projectId: string): Matches {
  const page = validated(validateProjectContextSearchResultV2, raw);
  if (page.project_id !== projectId) throw new ViewError();
  return { items: page.items.map(match) };
}

/** Saved notes of one version found by a search. Either version opens by its ref. */
export function noteMatchesView(raw: unknown, version: 2 | 3): Match[] {
  const page = version === 3 ? validated(validatePersonUploadSearchResultV3, raw) : validated(validatePersonUploadSearchResultV2, raw);
  return page.results.map(match);
}

/** A cited passage of an original, as the contract has it. */
type SourceRevision = Extract<PersonAnswerCitationV8['citation'], { readonly kind: 'source_revision' }>;

function sourceRef({ source_id, revision_id, source_sha256, representation_sha256, anchor_sha256, document_id }: SourceRevision): SourceRef {
  return { source_id, revision_id, source_sha256, representation_sha256, anchor_sha256, ...(document_id === undefined ? {} : { document_id }) };
}

const SHA256 = /^sha256:[a-f0-9]{64}$/;
const POLICIES: ReadonlySet<string> = new Set<RecordPolicy>(['organization-member-readable-person-v2', 'restricted-reviewer-person-v2', 'project-members-readable-person-v1']);

/** A record the page may ask the host to read: a well-formed digest and a known policy. */
export function isRecordRef(value: unknown): value is RecordRef {
  const record = value !== null && typeof value === 'object' ? value as Json : {};
  return typeof record.record_sha256 === 'string' && SHA256.test(record.record_sha256) &&
    typeof record.policy_id === 'string' && POLICIES.has(record.policy_id);
}

/**
 * An Agentic Ask answer (V8): its statements, each with the exact sources
 * that support it, in the answer's order, and a streamed answer's receipt,
 * built by the Authority from what passed its final check. It is the last
 * line `person ask --progress` printed, in every scope: the answer on `/v7`,
 * with its receipt when the Authority streamed it (ADR-0039, ADR-0040,
 * research tool contract v1). An answer to an Ask that carried `previous`
 * (ADR-0047) also says the full question it answers, Ask again's "since" (its
 * citations among the answer's), or, asking which one (`clarify`), the
 * choices and no part. Its notice and its parts' gaps stay out of its plain
 * reading: the page shows neither.
 */
export function answerView(raw: unknown, scope: AskScope): Answer {
  const { result, receipt } = validated(validatePersonAskProgressResultLineV3, raw);
  const { direct, parts, outcome } = result;
  const sources = result.citations.map(citedSource);
  // One part answers the question itself, so its question is not repeated.
  const single = parts.length === 1;
  const textValue = [direct?.text, ...parts.flatMap(part => [single ? undefined : part.question, ...part.statements.map(statement => statement.text),
    ...(part.records?.map(record => record.text) ?? [])])]
    .filter((line): line is string => typeof line === 'string' && line !== '').join('\n');
  return { text: textValue, scope, sources, ...(direct === undefined ? {} : { direct }), parts, outcome,
    ...(receipt === undefined ? {} : { receipt: { looked_through: receipt.looked_through, elapsed_ms: receipt.elapsed_ms, rows: receipt.rows.map(askRow) } }),
    ...(result.question === undefined ? {} : { question: result.question }),
    ...(result.since === undefined ? {} : { since: result.since.statements }),
    ...(result.choices === undefined ? {} : { choices: result.choices }) };
}

/** Who alone may read an item cited as private: you, or the approver. */
const PRIVATE_VISIBILITY: ReadonlySet<string> = new Set(['only_me', 'approver_only']);

/**
 * An answer's cited item, and whether only you can read it: a table row that
 * cites it shows the lock (ADR-0045). It keeps the citation as the response
 * carried it, for a later follow-up's `previous` and, when it can change or
 * go, a later check (ADR-0047).
 */
function citedSource(citation: PersonAnswerCitationV8): AnswerSource {
  const source = { ...answerSource(citation), cited: citation };
  return PRIVATE_VISIBILITY.has(citation.visibility) ? { ...source, private: true } : source;
}

/**
 * What `person ask-check` printed (C1), as the page may see it: one state per
 * item asked, in their order, and a readable ticket's current marker. A reply
 * with another number of items, or anything else, is not its output.
 */
export function askCheckView(raw: unknown, asked: number): { items: AskCheckResult[] } {
  const check = validated(validatePersonAskCheckV1, raw);
  if (check.items.length !== asked) throw new ViewError();
  return { items: check.items.map(({ state, marker }) => ({ state, ...(marker === undefined ? {} : { marker }) })) };
}

/**
 * What `person project-activity` printed (C2): per project you are in, the
 * newest arrival from someone else that you can read, or null. At most 500,
 * each project once.
 */
export function projectActivityView(raw: unknown): { items: ProjectActivity[] } {
  return { items: validated(validatePersonProjectActivityV1, raw).items.map(({ project_id, latest_at }) => ({ project_id, latest_at })) };
}

function askRow(row: PersonAskReceiptRowV3): AskSearched | AskRead {
  return row.type === 'searched'
    ? { type: 'searched', sources: row.sources.map(source => 'tool_id' in source ? { kind: source.kind, tool_id: source.tool_id } : { kind: source.kind }), found: row.found }
    : { type: 'read', items: row.items.map(answerSource) };
}

/**
 * One line `person ask --progress` printed before its answer: a step of the
 * Ask, as progress V3 has it (ADR-0039, ADR-0040, research tool contract v1).
 * Only the stage, a search's source kinds and count, and the items just read
 * cross, each item as an answer's citation does, a follow-up, a project, a
 * person, a tool or a tool's container included. Anything else is refused.
 */
export function askStepView(raw: unknown): AskStep {
  const step = validated(validatePersonAskProgressLineV3, raw).progress;
  if (step.type !== 'stage') return askRow(step);
  return { type: 'stage', stage: step.stage, ...(step.pending === undefined ? {} : { pending: step.pending }) };
}

/**
 * An original's passage, by what its ref opens: its note, document or
 * imported meeting. A document's id opens it when no ref came.
 */
function originalSource(citation: SourceRevision, label: string, ref: string | undefined): AnswerSource {
  const passage = sourceRef(citation);
  const opens = ref ?? (passage.document_id === undefined ? undefined : `document:${passage.document_id}`);
  return opens === undefined ? { kind: 'original', label, ref: passage } : { kind: 'original', label, ref: passage, item: itemRef(opens) };
}

/**
 * One cited item, as the contract has it, kept by what it names: an approved
 * record by its digest and policy, an original by its revision and anchor, a
 * live ticket or page by its permalink, a follow-up, a project,
 * a person or a tool by its id, and a container in a tool you connected by its
 * link, its scope and own id left behind. A name Ask shows while it works, or
 * in its receipt, is such a citation too: it opens the same way.
 */
function answerSource({ citation, label, ref, key }: PersonAnswerCitationV8): AnswerSource {
  switch (citation.kind) {
    case 'approved_record':
      return { kind: 'record', label, record: { record_sha256: citation.record_sha256, policy_id: citation.policy_id }, atom_id: citation.atom_id };
    case 'source_revision': return originalSource(citation, label, ref);
    case 'follow_up': return { kind: 'follow_up', label, item_id: citation.item_id };
    case 'project': return { kind: 'project', label, project_id: citation.project_id };
    case 'person': return { kind: 'person', label, membership_id: citation.membership_id };
    case 'tool': return { kind: 'tool', label, tool_id: citation.tool_id };
    case 'tool_container':
      return { kind: 'container', tool_id: citation.tool_id, label, permalink: citation.permalink, container: citation.container, ...(key === undefined ? {} : { key }) };
    default: {
      // Live evidence opens in its own app, by a link the page and main check by its kind's rule.
      const permalink = externalSourcePermalink(citation.kind, citation.permalink);
      if (permalink === null) throw new ViewError();
      return { kind: citation.kind, tool_id: citation.tool_id, label, permalink };
    }
  }
}

/**
 * One open item, validated by the client. What it says now crosses only
 * when the Authority opened it for this viewer (`reach: 'opened'`), its
 * citation as a source "Open in …" can open; the tool's own coordinates stay
 * behind. Any other `reach` says why there is none.
 */
export function openItemView(item: PersonOpenItemV1): OpenItemView {
  const current = item.current;
  return {
    item_id: item.item_id, run_id: item.run_id, kind: item.kind,
    ...(item.decision === undefined ? {} : { decision: item.decision }),
    ...(current === undefined ? {} : { current: {
      source: answerSource(current.citation), says_now: current.says_now,
      ...(current.assignee === undefined ? {} : { assignee: current.assignee }),
      ...(current.status === undefined ? {} : { status: current.status }),
      ...(current.due_at === undefined ? {} : { due_at: current.due_at }),
    } }),
    relation: item.relation, expected: item.expected, approver: item.approver, owner: item.owner, waits_on: item.waits_on, state: item.state,
    created_at: item.created_at, sent_at: item.sent_at, state_set_at: item.state_set_at, state_set_by: item.state_set_by, owner_set_at: item.owner_set_at,
    owner_set_by: item.owner_set_by, send_included: item.send_included, check: item.check, can: item.can, reach: item.reach,
  };
}

/** Home's part of the runs: Send rows, the items that wait on this viewer, the counts of the rest, and whether a sweep is due. */
export function homeView(result: PersonRunsResultsV1['home']): HomeView {
  return {
    send: result.send, items: result.items.map(openItemView), landed: result.landed, waiting: result.waiting, last_checked_at: result.last_checked_at,
    sweep_due: result.sweep_due,
  };
}

/** A page of a scope's open items, with the scope's summary and each decision's check. */
export function openItemsView(result: PersonRunsResultsV1['items']): OpenItemsView {
  return { items: result.items.map(openItemView), next_cursor: result.next_cursor, summary: result.summary, stages: result.stages };
}

/** Longest text the source pane shows, in characters; longer is cut and marked. */
const MAX_SOURCE_TEXT = 2_000;
/** Longest part of an approved item the reader shows, in characters: more than one part holds (3 KiB). */
const MAX_READER_TEXT = 4_000;
/** Items shown per section, and participants shown. */
const MAX_RECORD_ITEMS = 32;

/**
 * Text as the source pane or the reader may show it: control and format
 * characters made spaces, trimmed, and at most `maximum` characters. Nothing
 * left is none.
 */
function sourceText(value: unknown, maximum = MAX_SOURCE_TEXT): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  if (cleaned === '') return undefined;
  const characters = [...cleaned];
  return characters.length > maximum ? `${characters.slice(0, maximum - 1).join('')}… (truncated)` : cleaned;
}

/** An ISO 8601 time the renderer can format, or none. */
function isoTime(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

/**
 * An approved item's id as the Authority's citations carry it: the digest of
 * its record and its signal's id, never the signal id itself.
 */
export function atomId(recordSha256: string, signalId: string): string {
  return canonicalSha256({ kind: 'echo-organization-record-atom', record_hash: recordSha256, signal_id: signalId });
}

/**
 * One section of the approved brief. Every item must be of the section's kind,
 * with its own id and some text, or the whole record is refused. The first 32
 * show, each with its first three distinct excerpts.
 */
function recordSection(raw: unknown, kind: 'decision' | 'action' | 'rationale', record: string, owners: ReadonlyMap<string, string> = new Map()): RecordSection {
  const ids = new Set<string>();
  const items: RecordItem[] = [];
  const entries = list(raw);
  for (const entry of entries) {
    const item = object(entry);
    const itemText = sourceText(item.text);
    if (item.kind !== kind || typeof item.id !== 'string' || item.id === '' || ids.has(item.id) || itemText === undefined) {
      throw new ViewError();
    }
    ids.add(item.id);
    if (items.length === MAX_RECORD_ITEMS) continue;
    const excerpts: { quote: string; at?: string }[] = [];
    for (const span of Array.isArray(item.evidence) ? item.evidence.slice(0, 32) : []) {
      const found = span !== null && typeof span === 'object' ? span as Json : {};
      const quote = sourceText(found.quote);
      if (quote === undefined || excerpts.some(excerpt => excerpt.quote === quote)) continue;
      const at = isoTime(found.started_at);
      excerpts.push(at === undefined ? { quote } : { quote, at });
      if (excerpts.length === 3) break;
    }
    const status = kind === 'decision' && (item.status === 'proposed' || item.status === 'unresolved') ? item.status : undefined;
    const owner = kind === 'action' ? owners.get(item.id) : undefined;
    items.push({ text: itemText, ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), excerpts, atom_id: atomId(record, item.id) });
  }
  return { items, more: entries.length > MAX_RECORD_ITEMS };
}

/** Owners the approver confirmed in the signed approval, by action id; the brief itself never has them. */
function confirmedOwners(reference: unknown): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  const entries = reference !== null && typeof reference === 'object' ? (reference as Json).action_owners : undefined;
  for (const entry of Array.isArray(entries) ? entries.slice(0, 40) : []) {
    const found = entry !== null && typeof entry === 'object' ? entry as Json : {};
    const owner = sourceText(found.owner);
    if (typeof found.signal_id === 'string' && owner !== undefined && owner.length <= 120) owners.set(found.signal_id, owner);
  }
  return owners;
}

/**
 * The one approved record asked for, as `person records --record-sha256`
 * prints it: only an approved event under the policy the answer cited. Only
 * what the pane shows is copied, and each item's atom id, the digest its
 * citations carry; participants' identities and signal ids stay behind.
 */
export function recordView(raw: unknown, asked: RecordRef): ApprovedRecord {
  const root = object(raw);
  if (root.ok !== true) throw new ViewError();
  const value = object(root.result);
  if (value.schema_version !== 1 || value.kind !== 'echo-clean-person-record-list-v1') throw new ViewError();
  const records = list(value.records);
  // A record the person can no longer read comes back as an empty list.
  if (records.length === 0) throw new NotReadable();
  if (records.length !== 1) throw new ViewError();
  const record = object(records[0]);
  const envelope = object(record.envelope);
  if (typeof record.position !== 'number' || record.position < 1 ||
      record.record_sha256 !== asked.record_sha256 || envelope.record_sha256 !== asked.record_sha256) {
    throw new ViewError();
  }
  const body = object(envelope.body);
  const event = object(body.event);
  if (event.kind !== 'approved' || event.policy_id !== asked.policy_id) throw new ViewError();
  const brief = object(object(object(event.approved_snapshot).approved_payload).brief);
  const meeting = object(brief.meeting);
  // Each item carries its atom id, so the pane can light the ones an answer cites.
  const decisions = recordSection(brief.decisions, 'decision', asked.record_sha256);
  const actions = recordSection(brief.actions, 'action', asked.record_sha256, confirmedOwners(body.human_act_resolution_ref));
  const rationales = recordSection(brief.rationales, 'rationale', asked.record_sha256);

  const participants: string[] = [];
  let participantsMore = false;
  for (const entry of Array.isArray(meeting.participants) ? meeting.participants.slice(0, 10_000) : []) {
    const name = sourceText(entry !== null && typeof entry === 'object' ? (entry as Json).display_name : undefined);
    if (name === undefined || participants.includes(name)) continue;
    if (participants.length === MAX_RECORD_ITEMS) { participantsMore = true; break; }
    participants.push(name);
  }
  const time = meeting.time !== null && typeof meeting.time === 'object' ? meeting.time as Json : {};
  const startedAt = isoTime(time.actual_start_at) ?? isoTime(time.scheduled_start_at);
  const timezone = typeof time.timezone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(time.timezone) ? time.timezone : undefined;
  const metadata = record.source_metadata !== null && typeof record.source_metadata === 'object' ? record.source_metadata as Json : {};
  const approver = metadata.record_approved_by !== null && typeof metadata.record_approved_by === 'object'
    ? sourceText((metadata.record_approved_by as Json).display_name) : undefined;
  const title = sourceText(meeting.title);
  return {
    ...(title === undefined ? {} : { title }),
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(timezone === undefined ? {} : { timezone }),
    all_day: time.all_day === true,
    ...(approver === undefined ? {} : { approved_by: approver }),
    participants, participants_more: participantsMore,
    visibility: asked.policy_id === 'restricted-reviewer-person-v2' ? 'approver'
      : asked.policy_id === 'project-members-readable-person-v1' ? 'project' : 'organization',
    decisions, actions, rationales,
  };
}

const SECTIONS: Readonly<Record<PersonOpenMeetingAtomV1['kind'], 'decisions' | 'actions' | 'rationales'>> = { decision: 'decisions', action: 'actions', rationale: 'rationales' };

/**
 * One part of a long approved item: controls made spaces, but not trimmed,
 * since the parts join exactly as they were cut.
 */
function partText(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, ' ');
}

/** Text the reader shows, controls made spaces and trimmed: a page with nothing left of it is refused. */
function shownText(text: string): string {
  const shown = sourceText(text, MAX_READER_TEXT);
  if (shown === undefined) throw new ViewError();
  return shown;
}

/** A long item whose parts are all read: its whole text, trimmed, and no parts left to join. */
function whole(item: RecordItem): RecordItem {
  const { parts: _parts, ...rest } = item;
  const joined = item.text.trim();
  if (joined === '') throw new ViewError();
  return { ...rest, text: joined };
}

/**
 * One page of a meeting's approved record, as the reader shows it. Only the
 * first page describes the meeting (when, who was there, who approved it).
 * A long item comes in parts: each part goes on the item before it, and only
 * a page read with a cursor may begin with a part that goes on the page
 * before. Who can read it follows the row: everyone, a project's members, or
 * the approver. Every id stays behind.
 */
function meetingRecord(page: PersonOpenMeetingV1, item: ListItem, first: boolean): ApprovedRecord {
  if ((page.meeting !== undefined) !== first) throw new ViewError();
  const sections: Record<'decisions' | 'actions' | 'rationales', RecordItem[]> = { decisions: [], actions: [], rationales: [] };
  // The section of a long item whose parts are not all read yet: the next part must go on it.
  let open: 'decisions' | 'actions' | 'rationales' | null = null;
  page.atoms.forEach((atom, position) => {
    const section = SECTIONS[atom.kind];
    const items = sections[section];
    const part = atom.part ?? null;
    if (part && part.index > 1) {
      const { index, count } = part;
      const last = items.at(-1);
      let joined: RecordItem;
      if (open === section && last?.parts && last.parts.to === index - 1 && last.parts.count === count) {
        joined = { ...last, text: last.text + partText(atom.text), parts: { ...last.parts, to: index } };
        items[items.length - 1] = joined;
      } else if (position === 0 && !first) {
        joined = { text: partText(atom.text), excerpts: [], parts: { from: index, to: index, count } };
        items.push(joined);
      } else {
        throw new ViewError();
      }
      open = index === count ? null : section;
      // Every part read here: the item is whole. One begun on the page before stays in parts, to be joined.
      if (index === count && joined.parts!.from === 1) items[items.length - 1] = whole(joined);
      return;
    }
    // A long item's parts all come before the next item.
    if (open !== null) throw new ViewError();
    // Only a decision has a status, and only an action an owner.
    const status = atom.status === 'proposed' || atom.status === 'unresolved' ? atom.status : undefined;
    const owner = sourceText(atom.owner);
    const attributes = { ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }) };
    if (part) {
      items.push({ text: partText(atom.text), ...attributes, excerpts: [], parts: { from: 1, to: 1, count: part.count } });
      open = section;
      return;
    }
    items.push({ text: shownText(atom.text), ...attributes, excerpts: [] });
  });

  const meeting = page.meeting;
  const participants = meeting?.participants.map(shownText) ?? [];
  if (new Set(participants).size !== participants.length) throw new ViewError();
  const approver = sourceText(meeting?.approved_by);
  return {
    title: item.title, added_at: item.added_at,
    ...(meeting?.started_at === undefined ? {} : { started_at: meeting.started_at }),
    ...(meeting?.timezone === undefined ? {} : { timezone: meeting.timezone }),
    all_day: meeting?.all_day === true,
    ...(approver === undefined ? {} : { approved_by: approver }),
    participants, participants_more: meeting?.participants_more === true,
    visibility: item.visibility === 'team' ? 'organization' : item.visibility === 'project' ? 'project' : 'approver',
    decisions: { items: sections.decisions, more: false },
    actions: { items: sections.actions, more: false },
    rationales: { items: sections.rationales, more: false },
  };
}

export function evidenceView(raw: unknown): SourceEvidence {
  const evidence = validated(validatePersonSourceEvidenceV1, unwrap(raw));
  return { label: evidence.citation.label, text: evidence.text };
}

/** Paste a meeting's reply: only the id the meeting's content derives, the same for the same meeting. */
export function pastedView(raw: unknown): { meeting_id: string } {
  const { meeting_id: meetingId } = validated(value => validatePersonMeetingResultV2('submit', value), unwrap(raw));
  if (!PERSON_HAND_IN_MEETING_ID_V1.test(meetingId)) throw new ViewError();
  return { meeting_id: meetingId };
}

/** Connected tools: each tool's id, name and your connection. External workspace and account ids stay behind. */
export function toolsView(raw: unknown, membershipId: string): ConnectedTools {
  const tools = validated(validateOrganizationPersonToolsV4, unwrap(raw));
  if (tools.membership_id !== membershipId) throw new ViewError();
  return { tools: tools.tools.map(tool => ({ tool_id: tool.tool_id, name: tool.display_name, status: tool.personal_status })) };
}

/** A tool id as the client takes it after --tool. */
export const TOOL_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** An attempt id as a tool prints it: Slack's sbl_…, Jira's UUID. */
export const TOOL_ATTEMPT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ATTEMPT_STATUS: ReadonlySet<string> = new Set(['pending', 'complete', 'cancelled', 'expired', 'failed']);

/** connect --no-wait: the waiting line, whichever key the tool names its attempt with. */
export function toolAttemptView(raw: unknown): ToolAttempt {
  const value = object(raw);
  const attemptId = value.attempt_id ?? value.attempt;
  const expiresAt = isoTime(value.expires_at);
  if (value.phase !== 'waiting' || typeof attemptId !== 'string' || !TOOL_ATTEMPT_ID.test(attemptId) || expiresAt === undefined) throw new ViewError();
  return { attempt_id: attemptId, expires_at: expiresAt };
}

/** status and cancel: only where the attempt is and the tool's failure code. */
export function toolAttemptStatusView(raw: unknown): ToolAttemptStatus {
  const value = object(object(raw).result);
  const reason = value.failure_reason;
  if (typeof value.status !== 'string' || !ATTEMPT_STATUS.has(value.status) ||
    !(reason === null || reason === undefined || (typeof reason === 'string' && /^[a-z_]{1,64}$/.test(reason)))) throw new ViewError();
  return { status: value.status as ToolAttemptStatus['status'], failure_reason: typeof reason === 'string' ? reason : null };
}

const EXTRACTION: ReadonlySet<string> = new Set<Extraction>([
  'extracting', 'ready', 'partial', 'no_text', 'encrypted', 'malformed', 'limit_exceeded', 'timed_out', 'unsupported', 'unavailable',
]);
/** A document's extraction state, only as one of the known codes. A minimal "saved" receipt has none. */
function extraction(value: Json): { extraction: Extraction } | Record<string, never> {
  return typeof value.extraction_state === 'string' && EXTRACTION.has(value.extraction_state)
    ? { extraction: value.extraction_state as Extraction } : {};
}

export function receiptView(raw: unknown, requestId: string, audience: Audience): Receipt {
  const value = object(raw);
  if (value.request_id !== requestId) throw new ViewError();
  return { request_id: requestId, audience, ...extraction(value) };
}

/** The client removed (or never had) its kept copy of this request's document. */
export function abandonView(raw: unknown, requestId: string): null {
  const value = object(unwrap(raw));
  if (value.kind !== 'echo-person-document-abandoned-v1' || value.request_id !== requestId) throw new ViewError();
  return null;
}

/** NOTE_STATUS holds both a note's full V3 status and the saved-only one sent once you leave a project it names. */
const NOTE_STATUS: ReadonlySet<unknown> = new Set(['echo-person-update-status-v3', 'echo-person-update-saved-v3']);
/** A note's V3 status, or a document's V2 status: stored means saved. */
export function writeStatusView(raw: unknown, kind: 'note' | 'document'): WriteStatus {
  const value = object(kind === 'document' ? unwrap(raw) : raw);
  if (kind === 'note') return { state: NOTE_STATUS.has(value.kind) && value.status === 'stored' ? 'saved' : 'unknown' };
  return value.state === 'saved' ? { state: 'saved', ...extraction(value) } : { state: 'unknown' };
}

const RETRYABLE = new Set(['unavailable', 'transport_failed', 'rate_limited', 'timeout', 'outcome_unknown', 'invalid_output', 'busy']);
/** A write that failed this way may have reached the Authority, unless the client says otherwise. */
const MAYBE_SENT = new Set(['outcome_unknown', 'timeout', 'unavailable', 'transport_failed']);

/** A failure the renderer may see: a code, never the server's or client's text. */
export function failureView(raw: unknown, fallback: string, write: boolean, requestId?: string): Failure {
  const value = raw !== null && typeof raw === 'object' ? raw as Json : {};
  // A tool step that was refused, cancelled or unfinished names its reason instead of a code.
  const code = typeof value.code === 'string' && /^[a-z_]{1,64}$/.test(value.code) ? value.code
    : typeof value.reason === 'string' && /^[a-z_]{1,64}$/.test(value.reason) ? value.reason : fallback;
  // An employee change says more: one the Authority refused was not made, and
  // one it made (whose invitation file could not be written) is not unknown.
  const reported = value.mutation_outcome;
  const outcome = reported === 'unknown' || reported === 'not_submitted' ? reported
    : reported === 'rejected' ? 'not_submitted'
    : reported === 'committed' ? undefined
    : write ? (MAYBE_SENT.has(code) ? 'unknown' : 'not_submitted') : undefined;
  return {
    code,
    retryable: RETRYABLE.has(code),
    ...(outcome === undefined ? {} : { mutation_outcome: outcome }),
    ...(requestId === undefined ? {} : { request_id: requestId }),
  };
}

/**
 * A title the API accepts: the first non-empty line, controls and tabs made
 * spaces, at most 200 UTF-8 bytes, cut only between whole characters.
 */
export function noteTitle(body: string): string {
  const line = body.split(/\r?\n/).map(part => part.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()).find(part => part.length > 0) ?? '';
  let bytes = 0;
  let title = '';
  for (const character of line) {
    if (/[\uD800-\uDFFF]/.test(character) && character.length === 1) continue; // lone surrogate
    const size = Buffer.byteLength(character);
    if (bytes + size > 200) break;
    bytes += size;
    title += character;
  }
  return title.trim();
}

/** The CLI validates provider coordinates; only the project key and opaque revision reach the UI. */
export function projectJiraMappingView(raw: unknown, projectId: string): ProjectJiraMapping {
  const value = object(unwrap(raw));
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (value.schema_version !== 1 || value.project_id !== projectId || (value.revision !== null && !uuid.test(text(value.revision)))) throw new ViewError();
  const selected = value.mapping === null ? null : object(value.mapping);
  if (selected !== null && (value.revision === null || !/^[1-9][0-9]{0,19}$/.test(text(selected.project_id)) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(text(selected.project_key)))) throw new ViewError();
  return { project_id: projectId, revision: value.revision as string | null,
    mapping: selected === null ? null : { project_id: text(selected.project_id), project_key: text(selected.project_key) } };
}

export function projectConfluenceMappingView(raw: unknown, projectId: string): ProjectConfluenceMapping {
  const value = object(unwrap(raw)); const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (value.schema_version !== 1 || value.project_id !== projectId || (value.revision !== null && !uuid.test(text(value.revision)))) throw new ViewError();
  const mapping = value.mapping === null ? null : object(value.mapping);
  if (mapping !== null && (value.revision === null || !Array.isArray(mapping.space_ids) || mapping.space_ids.length < 1 || mapping.space_ids.length > 20 || !mapping.space_ids.every(id => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id)))) throw new ViewError();
  return { project_id: projectId, revision: value.revision as string | null, mapping: mapping === null ? null : { space_ids: [...(mapping.space_ids as string[])] } };
}
export function confluenceSpacesView(raw: unknown): ConfluenceSpacesPage {
  const value = object(unwrap(raw)); if (value.schema_version !== 1 || !Array.isArray(value.items) || value.items.length > 20 || (value.next_cursor !== null && (typeof value.next_cursor !== 'string' || !/^[A-Za-z0-9_-]{1,4096}$/.test(value.next_cursor)))) throw new ViewError();
  const items = value.items.map(raw => { const item = object(raw); if (!/^[1-9][0-9]{0,19}$/.test(text(item.id))) throw new ViewError(); return { id: item.id as string, key: text(item.key), name: text(item.name) }; });
  if (new Set(items.map(item => item.id)).size !== items.length) throw new ViewError(); return { items, next_cursor: value.next_cursor as string | null };
}

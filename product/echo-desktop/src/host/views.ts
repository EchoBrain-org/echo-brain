// Turns the person client's validated JSON output into the token-free view
// models of ../shared/protocol.ts. Every field is copied explicitly, so nothing
// the client prints beyond these fields can reach the renderer.
import type {
  Account, Answer, AnswerPart, AnswerSource, AnswerStatement, AppStatus, ApprovedRecord, AskScope, Audience, ConnectedTools, CreatedProject, DocumentSummary,
  Employee, Employees, Extraction, Failure, InvitationSaved, ItemRef, ListItem, ListPage, ListScope, Match, Matches, Member, MemberPage, Opened,
  ProjectChange, ProjectConfluenceMapping, ConfluenceSpacesPage, ProjectJiraMapping, ProjectPage, ProjectSettingsReceipt, ProjectSummary, Receipt, RecordItem, RecordPolicy, RecordRef, RecordSection, SourceEvidence, SourceRef, TextChunk,
  ToolAttempt, ToolAttemptStatus, Visibility, WriteStatus,
} from '../shared/protocol.js';
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
function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
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

export function statusView(raw: unknown): AppStatus {
  const value = object(raw);
  if (value.kind !== 'echo-person-client-status-v1') throw new ViewError();
  const version = text(value.installed_version);
  if (value.signed_in !== true) return { signed_in: false, account: null, client_version: version };
  const role = value.membership_type;
  if (role !== 'owner' && role !== 'employee') throw new ViewError();
  const account: Account = {
    authority: text(value.connected_authority),
    membership_id: text(value.membership_id),
    display_name: text(value.display_name),
    role,
  };
  return { signed_in: true, account, client_version: version };
}

function projectSummary(raw: unknown): ProjectSummary {
  const value = object(raw);
  const role = value.role;
  if (role !== 'lead' && role !== 'member') throw new ViewError();
  const status = value.status;
  if (status !== 'active' && status !== 'archived') throw new ViewError();
  return { project_id: text(value.project_id), name: text(value.name), role, created_at: text(value.created_at), status };
}

export function projectPageView(raw: unknown): ProjectPage {
  const value = object(raw);
  if (value.kind !== 'echo-project-list-v2') throw new ViewError();
  return { items: list(value.items).map(projectSummary), next_cursor: optionalText(value.next_cursor) ?? null };
}

/** The project asked for, as it is now: your role in it may have changed. */
export function projectView(raw: unknown, projectId: string): ProjectSummary {
  const project = projectSummary(raw);
  if (object(raw).kind !== 'echo-project-summary-v2' || project.project_id !== projectId) throw new ViewError();
  return project;
}

/** A rename, archive/unarchive, or leave receipt, checked against exactly the request we sent. */
export function projectSettingsView(raw: unknown, requestId: string, projectId: string, operation: ProjectSettingsReceipt['operation']): ProjectSettingsReceipt {
  const value = object(raw);
  if (value.schema_version !== 1 || value.kind !== 'echo-project-settings-receipt-v1' || value.state !== 'applied' ||
      value.request_id !== requestId || value.project_id !== projectId || value.operation !== operation) throw new ViewError();
  return { request_id: requestId, project_id: projectId, operation };
}

/** Who can read an item, in the list's three words: a project row says nothing more about its projects. */
function visibility(value: unknown): Visibility {
  if (value === 'only_me') return 'only-me';
  if (value === 'team' || value === 'project') return value;
  throw new ViewError();
}

const MEDIA: Record<string, DocumentSummary['type']> = {
  'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'text/markdown': 'markdown', 'text/plain': 'text',
};

/** The id after each kind of ref, as the API writes it: `note:ctx_…`, `document:doc_…`, `meeting:sha256:…`. */
const ITEM_REF: Readonly<Record<ItemRef['kind'], RegExp>> = {
  note: /^ctx_[0-9a-f]{64}$/, document: /^doc_[0-9a-f]{64}$/, meeting: /^sha256:[0-9a-f]{64}$/,
};

function itemRef(raw: unknown): ItemRef {
  const value = text(raw);
  const at = value.indexOf(':');
  const kind = value.slice(0, at);
  const id = value.slice(at + 1);
  if (at < 0 || !Object.hasOwn(ITEM_REF, kind) || !ITEM_REF[kind as ItemRef['kind']].test(id)) throw new ViewError();
  return { kind: kind as ItemRef['kind'], id };
}

/** A row: its ref, title, when it was added, who can read it, and the names of your projects it is filed in. */
function listItem(raw: unknown): ListItem {
  const item = object(raw);
  const ref = itemRef(item.ref);
  const added = text(item.added_at);
  if (item.kind !== ref.kind || Number.isNaN(Date.parse(added))) throw new ViewError();
  const base = {
    ref, title: text(item.title), added_at: added, visibility: visibility(item.visibility),
    projects: list(item.projects).map(project => text(object(project).name)),
  };
  if (ref.kind === 'document') {
    const type = MEDIA[text(item.media_type)];
    const size = item.size_bytes;
    const state = text(item.extraction_state);
    if (type === undefined || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || !EXTRACTION.has(state)) throw new ViewError();
    return { ...base, document: { type, size, extraction: state as Extraction } };
  }
  if (ref.kind === 'meeting' && item.meeting_date !== undefined) {
    const date = text(item.meeting_date);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ViewError();
    return { ...base, meeting_date: date };
  }
  return base;
}

/** Rows a list page holds. */
const MAX_LIST_ITEMS = 25;

function nextCursor(value: unknown): string | null {
  if (value !== null && typeof value !== 'string') throw new ViewError();
  return value;
}

/**
 * One page of a list, only for the scope asked for. Nothing of its header
 * (who you are, your tools, your projects) crosses, and a row names your
 * projects it is filed in, never their ids.
 */
export function listView(raw: unknown, scope: ListScope): ListPage {
  const value = object(unwrap(raw));
  if (value.schema_version !== 1 || value.kind !== 'echo-person-list-v1') throw new ViewError();
  const project = scope.kind === 'project' ? scope.project_id : undefined;
  const echoed = object(value.scope);
  if (echoed.kind !== scope.kind || echoed.project_id !== project) throw new ViewError();
  if (value.project !== undefined && object(value.project).project_id !== project) throw new ViewError();
  const items = list(value.items);
  if (items.length > MAX_LIST_ITEMS) throw new ViewError();
  return { items: items.map(listItem), next_cursor: nextCursor(value.next_cursor), meetings_held: value.notice === 'meetings_unavailable' };
}

/**
 * The item asked for, opened by its ref: a note's text, one page of a
 * document's text, or one page of a meeting's approved record. `first` says
 * the page was read without a cursor.
 */
export function openView(raw: unknown, ref: ItemRef, first: boolean): Opened {
  const value = object(unwrap(raw));
  if (value.schema_version !== 1 || value.kind !== 'echo-person-open-v1' || value.ref !== `${ref.kind}:${ref.id}`) throw new ViewError();
  const item = listItem(value.item);
  if (item.ref.kind !== ref.kind || item.ref.id !== ref.id) throw new ViewError();
  // Where an original is filed crosses here only, so the reader can add it to another project.
  const project_ids = list(object(value.item).projects).map(project => text(object(project).project_id));
  const next = nextCursor(value.next_cursor);
  switch (ref.kind) {
    case 'note':
      if (next !== null) throw new ViewError();
      return { kind: 'note', content: {
        context_id: ref.id, title: item.title, text: text(value.text), received_at: item.added_at, audience: item.visibility, project_ids,
      } };
    case 'document': {
      if (!item.document) throw new ViewError();
      const chunks: TextChunk[] = list(value.chunks).map(entry => {
        const chunk = object(entry);
        const anchor = object(chunk.anchor);
        const start = anchor.start;
        if ((anchor.kind !== 'page' && anchor.kind !== 'paragraph') || typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1) {
          throw new ViewError();
        }
        return { anchor: anchor.kind, start, text: text(chunk.text) };
      });
      const { type, size, extraction } = item.document;
      return { kind: 'document', document: {
        document: {
          document_id: ref.id, title: item.title, filename: text(value.filename), received_at: item.added_at, type, size, audience: item.visibility,
          extraction, project_ids,
        },
        chunks, next_cursor: next,
      } };
    }
    case 'meeting':
      return { kind: 'meeting', record: meetingRecord(value, item, first), next_cursor: next };
  }
}

/** The original was written where the person chose, checked against its digest. The path stays behind. */
export function savedOriginalView(raw: unknown, documentId: string): null {
  const value = object(unwrap(raw));
  if (value.document_id !== documentId || typeof value.output_path !== 'string') throw new ViewError();
  return null;
}

function member(raw: unknown, directory: boolean): Member {
  const value = object(raw);
  const role = value.role;
  if (!directory && role !== 'lead' && role !== 'member') throw new ViewError();
  return {
    membership_id: text(value.membership_id), display_name: text(value.display_name),
    ...(directory ? {} : { role: role as 'lead' | 'member' }),
  };
}

/** One page of a project's members, or of the people its directory found, only for that project. */
export function membersView(raw: unknown, projectId: string, directory = false): MemberPage {
  const value = object(raw);
  const kind = directory ? 'echo-project-directory-v1' : 'echo-project-members-v1';
  if (value.kind !== kind || value.project_id !== projectId) throw new ViewError();
  return { items: list(value.items).map(item => member(item, directory)), next_cursor: optionalText(value.next_cursor) ?? null };
}

/** One page of the people in your organization, as `person directory` finds them: a name and a membership id each. */
export function directoryView(raw: unknown): MemberPage {
  const value = object(raw);
  if (value.schema_version !== 1 || value.kind !== 'echo-organization-directory-v1') throw new ViewError();
  return { items: list(value.items).map(item => member(item, true)), next_cursor: optionalText(value.next_cursor) ?? null };
}

/** The receipt for exactly the change that was sent: applied. */
export function changeView(raw: unknown, requestId: string, change: ProjectChange): null {
  const document = change.kind === 'document-associate' || change.kind === 'document-dissociate';
  const value = object(document ? unwrap(raw) : raw);
  if (value.state !== 'applied' || value.request_id !== requestId || value.project_id !== change.project_id) throw new ViewError();
  switch (change.kind) {
    case 'member-add':
    case 'member-set':
    case 'member-remove': {
      const operation = change.kind === 'member-remove' ? 'member_remove' : 'member_set';
      if (value.kind !== 'echo-project-mutation-receipt-v1' || value.operation !== operation || value.membership_id !== change.membership_id) {
        throw new ViewError();
      }
      return null;
    }
    case 'associate':
    case 'dissociate':
      if (value.kind !== 'echo-project-mutation-receipt-v1' || value.operation !== change.kind || value.context_id !== change.context_id) {
        throw new ViewError();
      }
      return null;
    case 'document-associate':
    case 'document-dissociate':
      if (value.kind !== 'echo-person-document-association-receipt-v1' || value.operation !== change.kind.slice('document-'.length) ||
          value.document_id !== change.document_id) throw new ViewError();
      return null;
  }
}

/** The receipt for exactly the create that was sent: its new project's id. */
export function createdView(raw: unknown, requestId: string): CreatedProject {
  const value = object(raw);
  if (value.kind !== 'echo-project-create-receipt-v1' || value.state !== 'created' || value.request_id !== requestId) throw new ViewError();
  return { project_id: text(value.project_id) };
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

function match(raw: unknown): Match {
  const item = object(raw);
  return { context_id: text(item.context_id), title: text(item.title), excerpt: text(item.excerpt), received_at: text(item.received_at) };
}

/** A project's search results, only for the project that was searched. */
export function projectMatchesView(raw: unknown, projectId: string): Matches {
  const value = object(raw);
  if (value.kind !== 'echo-project-context-search-result-v2' || value.project_id !== projectId) throw new ViewError();
  return { items: list(value.items).map(match) };
}

/** Saved notes of one version found by a search. Either version opens by its ref. */
export function noteMatchesView(raw: unknown, version: 2 | 3): Match[] {
  const value = object(raw);
  if (value.kind !== `echo-person-upload-search-v${version}`) throw new ViewError();
  return list(value.results).map(match);
}

function sourceRef(citation: Json): SourceRef {
  const document = optionalText(citation.document_id);
  return {
    source_id: text(citation.source_id),
    revision_id: text(citation.revision_id),
    source_sha256: text(citation.source_sha256),
    representation_sha256: text(citation.representation_sha256),
    anchor_sha256: text(citation.anchor_sha256),
    ...(document === undefined ? {} : { document_id: document }),
  };
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
 * A versioned Agentic Ask answer: its statements,
 * each with the exact sources that support it, in the answer's order. An
 * approved record is kept by its digest and policy, an original by its
 * revision and anchor, a live Slack message by its permalink; a source
 * without a label is "Evidence n".
 */
export function answerView(raw: unknown, scope: AskScope): Answer {
  const value = object(unwrap(raw));
  const tickets = value.schema_version === 5 && value.kind === 'echo-clean-person-answer-v5';
  const pages = value.schema_version === 6 && value.kind === 'echo-clean-person-answer-v6';
  if (!tickets && !pages && (value.schema_version !== 4 || value.kind !== 'echo-clean-person-answer-v4')) throw new ViewError();
  const sources = list(value.citations).map((entry, index) => v4Source(entry, `Evidence ${index + 1}`, tickets || pages, pages));
  const direct = value.direct === undefined ? undefined : v4Statement(value.direct, sources.length);
  const parts = list(value.parts).map(part => v4Part(part, sources.length));
  if (parts.length === 0) throw new ViewError();
  const outcome = value.outcome;
  if (outcome !== 'answered' && outcome !== 'partial' && outcome !== 'not_found' && outcome !== 'off_scope') throw new ViewError();
  const assumption = optionalText(value.assumption);
  const notice = optionalText(value.notice);
  // One part answers the question itself, so its question is not repeated.
  const single = parts.length === 1;
  const textValue = [direct?.text, ...parts.flatMap(part => [single ? undefined : part.question, ...part.statements.map(statement => statement.text),
    ...(part.records?.map(record => record.text) ?? []), part.gap])]
    .filter((line): line is string => typeof line === 'string' && line !== '').join('\n');
  return { text: textValue, scope, sources, ...(direct === undefined ? {} : { direct }), parts, outcome,
    ...(assumption === undefined ? {} : { assumption }), ...(notice === undefined ? {} : { notice }) };
}

function v4Source(raw: unknown, fallback: string, tickets: boolean, pages = false): AnswerSource {
  const item = object(raw);
  const citation = object(item.citation);
  const label = text(item.label);
  if (citation.kind === 'approved_record') {
    const record = { record_sha256: citation.record_sha256, policy_id: citation.policy_id };
    if (!isRecordRef(record)) throw new ViewError();
    return { kind: 'record', label: label || fallback, record };
  }
  if (citation.kind === 'source_revision') return { kind: 'original', label: label || fallback, ref: sourceRef(citation) };
  const kind = citation.kind === 'slack_message' ? 'slack'
    : tickets && item.kind === 'ticket' && citation.kind === 'ticket' ? 'ticket'
    : pages && item.kind === 'page' && citation.kind === 'page' ? 'page' : null;
  if (kind !== null) {
    const permalink = externalSourcePermalink(kind, citation.permalink);
    const tool_id = kind === 'slack' ? 'slack' : citation.tool_id;
    if (permalink === null || typeof tool_id !== 'string' || !TOOL_ID.test(tool_id)) throw new ViewError();
    return { kind, tool_id, label: label || fallback, permalink };
  }
  throw new ViewError();
}

function v4Statement(raw: unknown, sourceCount: number): AnswerStatement {
  const item = object(raw);
  if (typeof item.private !== 'boolean') throw new ViewError();
  const indexes = list(item.citation_indexes).map(value => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value >= sourceCount) throw new ViewError();
    return value;
  });
  if (indexes.length === 0 || new Set(indexes).size !== indexes.length) throw new ViewError();
  return { text: text(item.text), citation_indexes: indexes, private: item.private };
}

function v4Part(raw: unknown, sourceCount: number): AnswerPart {
  const item = object(raw);
  const status = item.status;
  if (status !== 'answered' && status !== 'partial' && status !== 'not_found' && status !== 'records_only') throw new ViewError();
  const gap = optionalText(item.gap);
  const records = item.records === undefined ? undefined : list(item.records).map(value => v4Statement(value, sourceCount));
  return { question: text(item.question), status, statements: list(item.statements).map(value => v4Statement(value, sourceCount)),
    ...(gap === undefined ? {} : { gap }), ...(records === undefined ? {} : { records }) };
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
 * One section of the approved brief. Every item must be of the section's kind,
 * with its own id and some text, or the whole record is refused. The first 32
 * show, each with its first three distinct excerpts.
 */
function recordSection(raw: unknown, kind: 'decision' | 'action' | 'rationale', owners: ReadonlyMap<string, string> = new Map()): RecordSection {
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
    items.push({ text: itemText, ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }), excerpts });
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
 * what the pane shows is copied; participants' identities stay behind.
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
  const decisions = recordSection(brief.decisions, 'decision');
  const actions = recordSection(brief.actions, 'action', confirmedOwners(body.human_act_resolution_ref));
  const rationales = recordSection(brief.rationales, 'rationale');

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

/** Parts a meeting's page holds. */
const MAX_OPEN_ATOMS = 25;
const SECTIONS: Readonly<Record<string, 'decisions' | 'actions' | 'rationales'>> = { decision: 'decisions', action: 'actions', rationale: 'rationales' };

/**
 * One part of a long approved item: controls made spaces, but not trimmed,
 * since the parts join exactly as they were cut.
 */
function partText(value: unknown): string {
  const part = text(value).replace(/[\p{Cc}\p{Cf}]/gu, ' ');
  if (part === '' || [...part].length > MAX_READER_TEXT) throw new ViewError();
  return part;
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
 * the approver. Its transcript's ref and every id stay behind.
 */
function meetingRecord(value: Json, item: ListItem, first: boolean): ApprovedRecord {
  if ((value.meeting !== undefined) !== first) throw new ViewError();
  const atoms = list(value.atoms);
  if (atoms.length > MAX_OPEN_ATOMS) throw new ViewError();
  const sections: Record<'decisions' | 'actions' | 'rationales', RecordItem[]> = { decisions: [], actions: [], rationales: [] };
  // The section of a long item whose parts are not all read yet: the next part must go on it.
  let open: 'decisions' | 'actions' | 'rationales' | null = null;
  atoms.forEach((entry, position) => {
    const atom = object(entry);
    const kind = text(atom.kind);
    const section = Object.hasOwn(SECTIONS, kind) ? SECTIONS[kind]! : null;
    if (!section) throw new ViewError();
    const items = sections[section];
    let part: { index: number; count: number } | null = null;
    if (atom.part !== undefined) {
      const { index, count } = object(atom.part);
      if (typeof index !== 'number' || typeof count !== 'number' || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) ||
          count < 2 || index < 1 || index > count) throw new ViewError();
      part = { index, count };
    }
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
    const status: RecordItem['status'] = kind === 'decision' && (atom.status === 'proposed' || atom.status === 'unresolved') ? atom.status : undefined;
    const owner = kind === 'action' ? sourceText(atom.owner) : undefined;
    const attributes = { ...(status === undefined ? {} : { status }), ...(owner === undefined ? {} : { owner }) };
    if (part) {
      items.push({ text: partText(atom.text), ...attributes, excerpts: [], parts: { from: 1, to: 1, count: part.count } });
      open = section;
      return;
    }
    const itemText = sourceText(atom.text, MAX_READER_TEXT);
    if (itemText === undefined) throw new ViewError();
    items.push({ text: itemText, ...attributes, excerpts: [] });
  });

  const detail = first ? object(value.meeting) : {};
  const participants = first ? list(detail.participants).map(name => {
    const shown = sourceText(name);
    if (shown === undefined) throw new ViewError();
    return shown;
  }) : [];
  if (participants.length > MAX_RECORD_ITEMS || new Set(participants).size !== participants.length) throw new ViewError();
  if (first && typeof detail.participants_more !== 'boolean') throw new ViewError();
  const startedAt = isoTime(detail.started_at);
  const timezone = typeof detail.timezone === 'string' && /^[A-Za-z0-9_+\-/]{1,64}$/.test(detail.timezone) ? detail.timezone : undefined;
  const approver = sourceText(detail.approved_by);
  return {
    title: item.title, added_at: item.added_at,
    ...(startedAt === undefined ? {} : { started_at: startedAt }),
    ...(timezone === undefined ? {} : { timezone }),
    all_day: detail.all_day === true,
    ...(approver === undefined ? {} : { approved_by: approver }),
    participants, participants_more: detail.participants_more === true,
    visibility: item.visibility === 'team' ? 'organization' : item.visibility === 'project' ? 'project' : 'approver',
    decisions: { items: sections.decisions, more: false },
    actions: { items: sections.actions, more: false },
    rationales: { items: sections.rationales, more: false },
  };
}

export function evidenceView(raw: unknown): SourceEvidence {
  const value = object(unwrap(raw));
  if (value.kind !== 'echo-person-source-evidence-v1') throw new ViewError();
  return { label: text(object(value.citation).label), text: text(value.text) };
}

/** Connected tools: each tool's id, name and your connection. External workspace and account ids stay behind. */
export function toolsView(raw: unknown, membershipId: string): ConnectedTools {
  const value = object(unwrap(raw));
  if (value.schema_version !== 4 || value.kind !== 'echo-organization-person-tools' || value.membership_id !== membershipId) {
    throw new ViewError();
  }
  const tools = list(value.tools);
  if (tools.length > 32) throw new ViewError();
  return {
    tools: tools.map(entry => {
      const tool = object(entry);
      const status = tool.availability === 'enabled' ? tool.personal_status : 'unavailable';
      if (typeof tool.tool_id !== 'string' || !TOOL_ID.test(tool.tool_id) ||
        (status !== 'linked' && status !== 'unlinked' && status !== 'revoked' && status !== 'unavailable')) throw new ViewError();
      return { tool_id: tool.tool_id, name: text(tool.display_name), status };
    }),
  };
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

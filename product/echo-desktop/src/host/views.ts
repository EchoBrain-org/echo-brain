// Turns the person client's validated JSON output into the token-free view
// models of ../shared/protocol.ts. Every field is copied explicitly, so nothing
// the client prints beyond these fields can reach the renderer.
import type {
  Account, Answer, AnswerSource, AppStatus, ApprovedRecord, AskScope, Audience, ConnectedTools, ContextContent, CreatedProject, DocumentPage,
  DocumentSummary, DocumentText, Employee, Employees, Extraction, Failure, FeedItem, FeedPage, InvitationSaved, Match, Matches, Member, MemberPage,
  ProjectChange, ProjectPage, ProjectSummary, Receipt, RecordItem, RecordPolicy, RecordRef, RecordSection, SourceEvidence, SourceRef, TextChunk,
  WriteStatus,
} from '../shared/protocol.js';

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
  return { project_id: text(value.project_id), name: text(value.name), role, created_at: text(value.created_at) };
}

export function projectPageView(raw: unknown): ProjectPage {
  const value = object(raw);
  if (value.kind !== 'echo-project-list-v1') throw new ViewError();
  return { items: list(value.items).map(projectSummary), next_cursor: optionalText(value.next_cursor) ?? null };
}

/** The project asked for, as it is now: your role in it may have changed. */
export function projectView(raw: unknown, projectId: string): ProjectSummary {
  const project = projectSummary(raw);
  if (object(raw).kind !== 'echo-project-summary-v1' || project.project_id !== projectId) throw new ViewError();
  return project;
}

/** Who can read an item: only you, everyone, or one or more projects' members. */
function audienceMark(raw: unknown): FeedItem['audience'] {
  const kind = object(raw).kind;
  return kind === 'only_me' ? 'only-me' : kind === 'team' ? 'team' : 'project';
}

/** A project's notes, one page, only for the project asked for. */
export function feedView(raw: unknown, projectId?: string): FeedPage {
  const value = object(raw);
  if (value.kind !== 'echo-project-context-feed-v2' || (projectId !== undefined && value.project_id !== projectId)) throw new ViewError();
  return {
    project_id: text(value.project_id),
    items: list(value.items).map(entry => {
      const item = object(entry);
      return {
        context_id: text(item.context_id), title: text(item.title), received_at: text(item.received_at), audience: audienceMark(item.audience),
      };
    }),
    next_cursor: optionalText(value.next_cursor) ?? null,
  };
}

const MEDIA: Record<string, DocumentSummary['type']> = {
  'application/pdf': 'pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'word',
  'text/markdown': 'markdown', 'text/plain': 'text',
};

/** A saved document's metadata (V2): its file, who can read it, and where its text stands. */
function documentSummary(raw: unknown): DocumentSummary {
  const value = object(raw);
  if (value.schema_version !== 2 || value.kind !== 'echo-person-document-metadata-v2') throw new ViewError();
  const type = MEDIA[text(value.detected_media_type)];
  const size = value.content_length;
  const state = text(value.extraction_state);
  if (type === undefined || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 1 || !EXTRACTION.has(state)) throw new ViewError();
  return {
    document_id: text(value.document_id), title: text(value.title), filename: text(value.filename), received_at: text(value.received_at),
    type, size, audience: audienceMark(value.audience), extraction: state as Extraction,
    project_ids: list(value.association_project_ids).map(text),
  };
}

/** One page of a project's documents, as `documents search-v2` lists them. */
export function documentPageView(raw: unknown): DocumentPage {
  const value = object(unwrap(raw));
  if (value.schema_version !== 2 || value.kind !== 'echo-person-document-search-result-v2') throw new ViewError();
  // A search hit carries where it matched; a list does not need it.
  const items = list(value.documents).map(entry => {
    const { excerpt: _excerpt, anchor: _anchor, ...metadata } = object(entry);
    return documentSummary(metadata);
  });
  return { items, next_cursor: optionalText(value.next_cursor) ?? null };
}

/** The document asked for, and one page of its text, which must be of that same original. */
export function documentTextView(raw: unknown, documentId: string): DocumentText {
  const value = object(unwrap(raw));
  const metadata = object(value.metadata);
  const page = object(value.text);
  const document = documentSummary(metadata);
  if (document.document_id !== documentId || page.kind !== 'echo-person-document-text-v1' || page.document_id !== documentId ||
      page.original_sha256 !== metadata.sha256) throw new ViewError();
  const chunks: TextChunk[] = list(page.chunks).map(entry => {
    const chunk = object(entry);
    const start = chunk.anchor_start;
    if ((chunk.anchor_kind !== 'page' && chunk.anchor_kind !== 'paragraph') || typeof start !== 'number' || !Number.isSafeInteger(start)) {
      throw new ViewError();
    }
    return { anchor: chunk.anchor_kind, start, text: text(chunk.text) };
  });
  return { document, chunks, next_cursor: optionalText(page.next_cursor) ?? null };
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

export function contextView(raw: unknown): ContextContent {
  const value = object(raw);
  if (value.kind !== 'echo-project-context-read-v2') throw new ViewError();
  return {
    context_id: text(value.context_id), title: text(value.title), text: text(value.text), received_at: text(value.received_at),
    audience: audienceMark(value.audience),
  };
}

function match(raw: unknown, source: Match['source']): Match {
  const item = object(raw);
  return {
    context_id: text(item.context_id), title: text(item.title), excerpt: text(item.excerpt), received_at: text(item.received_at), source,
  };
}

/** A project's search results, only for the project that was searched. */
export function projectMatchesView(raw: unknown, projectId: string): Matches {
  const value = object(raw);
  if (value.kind !== 'echo-project-context-search-result-v2' || value.project_id !== projectId) throw new ViewError();
  return { items: list(value.items).map(item => match(item, 'project')) };
}

/** Saved notes of one version found by a search. */
export function noteMatchesView(raw: unknown, version: 2 | 3): Match[] {
  const value = object(raw);
  if (value.kind !== `echo-person-upload-search-v${version}`) throw new ViewError();
  return list(value.results).map(item => match(item, version === 3 ? 'v3' : 'v2'));
}

/** A saved note read in full, only the one asked for. */
export function noteView(raw: unknown, version: 2 | 3, contextId: string): ContextContent {
  const value = object(raw);
  if (value.kind !== `echo-person-upload-content-v${version}` || value.context_id !== contextId) throw new ViewError();
  return {
    context_id: contextId, title: text(value.title), text: text(value.text), received_at: text(value.received_at), audience: audienceMark(value.audience),
  };
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
const POLICIES: ReadonlySet<string> = new Set<RecordPolicy>(['organization-member-readable-person-v2', 'restricted-reviewer-person-v2']);

/** A record the page may ask the host to read: a well-formed digest and a known policy. */
export function isRecordRef(value: unknown): value is RecordRef {
  const record = value !== null && typeof value === 'object' ? value as Json : {};
  return typeof record.record_sha256 === 'string' && SHA256.test(record.record_sha256) &&
    typeof record.policy_id === 'string' && POLICIES.has(record.policy_id);
}

/**
 * An answer and what it is based on, in the answer's order, each source once:
 * an approved record by its digest and policy, an original by its revision
 * and anchor. Labels are the Swift app's: "Approved record 1", or the
 * original's own label ("Original source 2" without one).
 */
export function answerView(raw: unknown, scope: AskScope): Answer {
  const value = object(unwrap(raw));
  if (value.kind !== 'echo-clean-person-answer-v3') throw new ViewError();
  const sources: AnswerSource[] = [];
  const seen = new Set<string>();
  for (const entry of list(value.citations)) {
    const citation = object(entry);
    const place = sources.length + 1;
    if (citation.kind === 'approved_record') {
      const record = { record_sha256: citation.record_sha256, policy_id: citation.policy_id };
      if (!isRecordRef(record)) throw new ViewError();
      const key = `record|${record.record_sha256}|${record.policy_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sources.push({ kind: 'record', label: `Approved record ${place}`, record });
    } else if (citation.kind === 'source_revision') {
      const ref = sourceRef(citation);
      const key = `original|${ref.source_id}|${ref.revision_id}|${ref.anchor_sha256}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const label = optionalText(citation.label)?.trim();
      sources.push({ kind: 'original', label: label ? label : `Original source ${place}`, ref });
    } else {
      throw new ViewError();
    }
  }
  return { text: text(value.answer), scope, sources };
}

/** Longest text the source pane shows, in characters; longer is cut and marked. */
const MAX_SOURCE_TEXT = 2_000;
/** Items shown per section, and participants shown. */
const MAX_RECORD_ITEMS = 32;

/**
 * Text as the source pane may show it: control and format characters made
 * spaces, trimmed, and at most 2,000 characters. Nothing left is none.
 */
function sourceText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
  if (cleaned === '') return undefined;
  const characters = [...cleaned];
  return characters.length > MAX_SOURCE_TEXT ? `${characters.slice(0, MAX_SOURCE_TEXT - 1).join('')}… (truncated)` : cleaned;
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
function recordSection(raw: unknown, kind: 'decision' | 'action' | 'rationale'): RecordSection {
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
    items.push({ text: itemText, ...(status === undefined ? {} : { status }), excerpts });
  }
  return { items, more: entries.length > MAX_RECORD_ITEMS };
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
  const event = object(object(envelope.body).event);
  if (event.kind !== 'approved' || event.policy_id !== asked.policy_id) throw new ViewError();
  const brief = object(object(object(event.approved_snapshot).approved_payload).brief);
  const meeting = object(brief.meeting);
  const decisions = recordSection(brief.decisions, 'decision');
  const actions = recordSection(brief.actions, 'action');
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
    visibility: asked.policy_id === 'organization-member-readable-person-v2' ? 'organization' : 'approver',
    decisions, actions, rationales,
  };
}

export function evidenceView(raw: unknown): SourceEvidence {
  const value = object(unwrap(raw));
  if (value.kind !== 'echo-person-source-evidence-v1') throw new ViewError();
  return { label: text(object(value.citation).label), text: text(value.text) };
}

/** Connected tools: each name and state. External workspace and account ids stay behind. */
export function toolsView(raw: unknown, membershipId: string): ConnectedTools {
  const value = object(unwrap(raw));
  if (value.schema_version !== 3 || value.kind !== 'echo-organization-person-tools' || value.membership_id !== membershipId) {
    throw new ViewError();
  }
  const tools = list(value.tools);
  if (tools.length > 32) throw new ViewError();
  return {
    tools: tools.map(entry => {
      const tool = object(entry);
      return { name: text(tool.display_name), enabled: tool.availability === 'enabled', linked: tool.personal_status === 'linked' };
    }),
  };
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

/** A note's V3 status, or a document's V2 status: stored means saved. */
export function writeStatusView(raw: unknown, kind: 'note' | 'document'): WriteStatus {
  const value = object(kind === 'document' ? unwrap(raw) : raw);
  if (kind === 'note') return { state: value.kind === 'echo-person-update-status-v3' && value.status === 'stored' ? 'saved' : 'unknown' };
  return value.state === 'saved' ? { state: 'saved', ...extraction(value) } : { state: 'unknown' };
}

const RETRYABLE = new Set(['unavailable', 'transport_failed', 'rate_limited', 'timeout', 'outcome_unknown', 'invalid_output', 'busy']);
/** A write that failed this way may have reached the Authority, unless the client says otherwise. */
const MAYBE_SENT = new Set(['outcome_unknown', 'timeout', 'unavailable', 'transport_failed']);

/** A failure the renderer may see: a code, never the server's or client's text. */
export function failureView(raw: unknown, fallback: string, write: boolean, requestId?: string): Failure {
  const value = raw !== null && typeof raw === 'object' ? raw as Json : {};
  const code = typeof value.code === 'string' && /^[a-z_]{1,64}$/.test(value.code) ? value.code : fallback;
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

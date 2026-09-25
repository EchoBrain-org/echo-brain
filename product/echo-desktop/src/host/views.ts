// Turns the person client's validated JSON output into the token-free view
// models of ../shared/protocol.ts. Every field is copied explicitly, so nothing
// the client prints beyond these fields can reach the renderer.
import type {
  Account, Answer, AnswerSource, AppStatus, AskScope, Audience, ConnectedTools, ContextContent, Failure, FeedItem, FeedPage,
  ProjectPage, ProjectSummary, Receipt, SourceEvidence, SourceRef, WriteStatus,
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

export function feedView(raw: unknown): FeedPage {
  const value = object(raw);
  if (value.kind !== 'echo-project-context-feed-v2') throw new ViewError();
  return {
    project_id: text(value.project_id),
    items: list(value.items).map(entry => {
      const item = object(entry);
      const kind = object(item.audience).kind;
      const audience: FeedItem['audience'] = kind === 'only_me' ? 'only-me' : kind === 'team' ? 'team' : 'project';
      return {
        context_id: text(item.context_id), title: text(item.title), received_at: text(item.received_at), audience,
      };
    }),
  };
}

export function contextView(raw: unknown): ContextContent {
  const value = object(raw);
  if (value.kind !== 'echo-project-context-read-v2') throw new ViewError();
  return { context_id: text(value.context_id), title: text(value.title), text: text(value.text), received_at: text(value.received_at) };
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

export function answerView(raw: unknown, scope: AskScope): Answer {
  const value = object(unwrap(raw));
  if (value.kind !== 'echo-clean-person-answer-v3') throw new ViewError();
  const sources: AnswerSource[] = list(value.citations).map(entry => {
    const citation = object(entry);
    if (citation.kind === 'source_revision') return { label: optionalText(citation.label) ?? 'Source', ref: sourceRef(citation) };
    if (citation.kind === 'approved_record') return { label: 'Approved decision', ref: null };
    throw new ViewError();
  });
  return { text: text(value.answer), scope, sources };
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

export function receiptView(raw: unknown, requestId: string, audience: Audience): Receipt {
  const value = object(raw);
  if (value.request_id !== requestId) throw new ViewError();
  return { request_id: requestId, audience };
}

/** A note's V3 status, or a document's V2 status: stored means saved. */
export function writeStatusView(raw: unknown, kind: 'note' | 'document'): WriteStatus {
  const value = object(kind === 'document' ? unwrap(raw) : raw);
  if (kind === 'note') return { state: value.kind === 'echo-person-update-status-v3' && value.status === 'stored' ? 'saved' : 'unknown' };
  return { state: value.state === 'saved' ? 'saved' : 'unknown' };
}

const RETRYABLE = new Set(['unavailable', 'transport_failed', 'rate_limited', 'timeout', 'outcome_unknown', 'invalid_output', 'busy']);
/** A write that failed this way may have reached the Authority, unless the client says otherwise. */
const MAYBE_SENT = new Set(['outcome_unknown', 'timeout', 'unavailable', 'transport_failed']);

/** A failure the renderer may see: a code, never the server's or client's text. */
export function failureView(raw: unknown, fallback: string, write: boolean, requestId?: string): Failure {
  const value = raw !== null && typeof raw === 'object' ? raw as Json : {};
  const code = typeof value.code === 'string' && /^[a-z_]{1,64}$/.test(value.code) ? value.code : fallback;
  const outcome = value.mutation_outcome === 'unknown' || value.mutation_outcome === 'not_submitted'
    ? value.mutation_outcome
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

/** A question the API accepts: NFC, one line, trimmed, at most 240 code points. */
export function askText(question: string): string {
  const line = question.normalize('NFC').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return [...line].slice(0, 240).join('').trim();
}

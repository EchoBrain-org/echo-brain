import { validatePersonDiagnosticCaptureIdV1, type PersonDiagnosticCaptureIdV1 } from './person-diagnostics-v1.js';
import { validatePersonTicketCitationV1 } from './person-ticket-citation-v1.js';
import { validatePersonPageCitationV1 } from './person-page-citation-v1.js';
import type { PersonAnswerCitationV5, PersonAnswerResponseV5 } from './person-answer-v5.js';
import type { PersonAnswerCitationV6, PersonAnswerResponseV6 } from './person-answer-v6.js';
import type { PersonAnswerCitationV7, PersonAnswerEvidenceCitationV7, PersonAnswerResponseV7 } from './person-answer-v7.js';
import {
  validatePersonWorkspaceRefV1, type PersonAnswerCitationV8, type PersonAnswerEvidenceCitationV8, type PersonAnswerOpenRefV8, type PersonAnswerResponseV8,
  type PersonEvidenceKindV5,
} from './person-answer-v8.js';
import { validatePersonFollowUpCitationV1, validatePersonFollowUpRefV1 } from './person-follow-up-evidence-v1.js';
import { PERSON_WORKSPACE_CITATION_KINDS_V1, validatePersonWorkspaceCitationV1 } from './person-workspace-citation-v1.js';
import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonDocumentIdV1 } from './person-documents-v1.js';
import { validatePersonQueryText } from './person-query.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import { validatePersonAnswerScopeV3, type PersonAnswerCitationV3, type PersonAnswerScopeV3 } from './person-answer-v3.js';
import { validatePersonOpenRefV1, type PersonOpenRefV1 } from './person-list-v1.js';
import {
  asEnumerableRecord as object,
  assertDigest,
  assertExactKeys,
  fail,
  MAX_ORGANIZATION_API_BODY_BYTES,
  utf8ByteLength,
} from './validation.js';

/** The Agentic Ask endpoint: the only Ask since ADR-0022 retired V1 and V2. */
/** Statements (and cited sentences) per answer part; raised from 5 by RFC-0003 so one-paragraph answers can cover multi-part questions. */
export const PERSON_ANSWER_MAX_STATEMENTS_PER_PART_V4 = 10;
export const PERSON_ANSWER_PATH_V3 = '/v3/person/ask';
export const PERSON_EVIDENCE_SEARCH_PATH_V1 = '/v3/person/evidence/search';
export const PERSON_EVIDENCE_OPEN_PATH_V1 = '/v3/person/evidence/open';
export const PERSON_CAPABILITIES_PATH_V1 = '/v3/person/capabilities';

/** Optional Ask headers; older Authorities ignore them, preserving client-first upgrades. */
export const PERSON_ASK_CLIENT_NOW_HEADER_V1 = 'x-echo-client-now';
export const PERSON_ASK_TIME_ZONE_HEADER_V1 = 'x-echo-time-zone';
export interface PersonAskTimeContextV1 {
  readonly now: string;
  readonly time_zone: string;
}
/** Query interpretation only. Client time never controls access, expiry, audits or deadlines. */
export function validatePersonAskTimeContextV1(now: unknown, timeZone: unknown): PersonAskTimeContextV1 | undefined {
  if (now === undefined && timeZone === undefined) return undefined;
  if (typeof now !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(now) || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now ||
      typeof timeZone !== 'string' || timeZone.length > 100 || !/^[A-Za-z0-9_+\-/]+$/.test(timeZone)) fail('Ask time context is invalid');
  try { new Intl.DateTimeFormat('en', { timeZone }).format(new Date(now)); }
  catch { fail('Ask time zone is invalid'); }
  return Object.freeze({ now, time_zone: timeZone });
}

export const PERSON_ANSWER_RESPONSE_MAX_BYTES_V4 = 64 * 1024;
export const PERSON_EVIDENCE_TEXT_MAX_BYTES_V1 = 3 * 1024;
export const PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1 = 64 * 1024;
export const PERSON_EVIDENCE_LABEL_MAX_BYTES_V1 = 1024;

export type PersonEvidenceKindV1 = 'imported_meeting' | 'decision' | 'action' | 'rationale' | 'note' | 'document_passage' | 'slack_message';
export type PersonEvidenceVisibilityV1 = 'only_me' | 'team' | 'project' | 'projects' | 'approver_only';
type ApprovedRecordPolicyV3 = Extract<PersonAnswerCitationV3, { readonly kind: 'approved_record' }>['policy_id'];

/**
 * A Slack message read live with the asker's own Slack token (RFC-0003).
 * Echo never stores the message; the coordinates and a text digest identify
 * it, and the permalink opens it in Slack for anyone Slack lets read it.
 */
export interface PersonSlackMessageCitationV1 {
  readonly kind: 'slack_message';
  readonly team_id: string;
  readonly channel_id: string;
  readonly message_ts: string;
  readonly thread_ts?: string;
  readonly permalink: string;
  readonly text_sha256: `sha256:${string}`;
}

/** Every citation an Ask answer or an evidence desk item may carry. Open requests stay V3-only. */
export type PersonAnswerEvidenceCitationV4 = PersonAnswerCitationV3 | PersonSlackMessageCitationV1;

export interface PersonAnswerRequestV3 {
  readonly schema_version: 3;
  readonly question: string;
  /** Exclusive with `mine`. */
  readonly project_id?: ProjectIdV1;
  /** Only what the asker added: their notes and uploads, and meetings they approved (ADR-0024). */
  readonly mine?: true;
  /** A capture prepared by this actor for this ordinary Ask. */
  readonly capture_id?: PersonDiagnosticCaptureIdV1;
}

export interface PersonAnswerStatementV4 {
  readonly text: string;
  readonly citation_indexes: readonly number[];
  readonly private: boolean;
}

/** Deterministic evidence fallback when a per-part writer cannot produce prose. */
export type PersonAnswerEvidenceFallbackV4 = PersonAnswerStatementV4;

export interface PersonAnswerPartV4 {
  readonly question: string;
  readonly status: 'answered' | 'partial' | 'not_found' | 'records_only';
  readonly statements: readonly PersonAnswerStatementV4[];
  readonly gap?: string;
  readonly records?: readonly PersonAnswerEvidenceFallbackV4[];
}

export interface PersonAnswerCitationV4 {
  readonly citation: PersonAnswerEvidenceCitationV4;
  readonly kind: PersonEvidenceKindV1;
  readonly label: string;
  readonly visibility: PersonEvidenceVisibilityV1;
  /** Opens the cited item with person open (ADR-0024). Never on a Slack message. */
  readonly ref?: PersonOpenRefV1;
}

export interface PersonAnswerResponseV4 {
  readonly schema_version: 4;
  readonly kind: 'echo-clean-person-answer-v4';
  readonly scope: PersonAnswerScopeV3;
  readonly outcome: 'answered' | 'partial' | 'not_found' | 'off_scope';
  readonly citations: readonly PersonAnswerCitationV4[];
  readonly direct?: PersonAnswerStatementV4;
  readonly parts: readonly PersonAnswerPartV4[];
  readonly assumption?: string;
  readonly notice?: string;
}

export interface PersonEvidenceSearchRequestV1 {
  readonly schema_version: 1;
  readonly query?: string;
  readonly kinds?: readonly PersonEvidenceKindV1[];
  readonly limit?: number;
  readonly project_id?: ProjectIdV1;
}

export interface PersonEvidenceOpenRequestV1 {
  readonly schema_version: 1;
  readonly citation: PersonAnswerCitationV3;
  readonly neighbours?: 0 | 1 | 2;
  readonly project_id?: ProjectIdV1;
}

export interface PersonEvidenceAttributesV1 {
  readonly owner?: string;
  readonly due_at?: string;
  readonly status?: string;
}

/** An inventory item omits text; a search or open result includes it. */
export interface PersonEvidenceDeskItemV1 {
  /** Opaque, server-owned desk identity. It is never a model-authored coordinate. */
  readonly id: string;
  readonly citation: PersonAnswerEvidenceCitationV4;
  readonly kind: PersonEvidenceKindV1;
  readonly text?: string;
  readonly label: string;
  readonly visibility: PersonEvidenceVisibilityV1;
  readonly attributes?: PersonEvidenceAttributesV1;
  /** YYYY-MM-DD when the source knows the date (Slack messages). */
  readonly occurred_at?: string;
  readonly receipt_sha256: `sha256:${string}`;
}

export interface PersonEvidenceDeskResponseV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-evidence-desk-v1';
  readonly scope: PersonAnswerScopeV3;
  readonly items: readonly PersonEvidenceDeskItemV1[];
  readonly truncated: boolean;
  readonly notice?: string;
}

export interface PersonCapabilitiesV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-capabilities-v1';
  readonly agentic_ask_v1: boolean;
}

function text(value: unknown, label: string, maximumBytes: number, multiline = false): asserts value is string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\p{Cc}\p{Zl}\p{Zp}]/u;
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    value !== value.normalize('NFC') || controls.test(value) || utf8ByteLength(value) > maximumBytes
  ) fail(`${label} is invalid`);
}

/** Immutable released packets retain their exact whitespace. */
function evidenceText(value: unknown, label: string, maximumBytes: number): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || utf8ByteLength(value) > maximumBytes
  ) fail(`${label} is invalid`);
}

/** Matches the existing V3 source-coordinate character limits, including non-ASCII labels. */
function coordinateText(value: unknown, label: string, maximumCodePoints: number): asserts value is string {
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value || value !== value.normalize('NFC') ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) || [...value].length > maximumCodePoints
  ) fail(`${label} is invalid`);
}

function scope(value: unknown): PersonAnswerScopeV3 {
  return validatePersonAnswerScopeV3(value, 'Ask response scope');
}

const SLACK_TEAM_ID = /^[TE][A-Z0-9]{2,30}$/;
const SLACK_CHANNEL_ID = /^[CDG][A-Z0-9]{2,30}$/;
const SLACK_TS = /^\d{9,11}\.\d{6}$/;
const SLACK_PERMALINK = /^https:\/\/[a-z0-9-]+(\.enterprise)?\.slack\.com\/archives\/[CDG][A-Z0-9]{2,30}\/p\d{15,17}(\?[A-Za-z0-9_=&.%-]{0,200})?$/;

function slackCitation(input: Record<string, unknown>): PersonSlackMessageCitationV1 {
  assertExactKeys(input, ['kind', 'team_id', 'channel_id', 'message_ts', 'permalink', 'text_sha256', ...(Object.hasOwn(input, 'thread_ts') ? ['thread_ts'] : [])], 'Ask citation');
  if (typeof input.team_id !== 'string' || !SLACK_TEAM_ID.test(input.team_id)) fail('Ask Slack citation team_id is invalid');
  if (typeof input.channel_id !== 'string' || !SLACK_CHANNEL_ID.test(input.channel_id)) fail('Ask Slack citation channel_id is invalid');
  if (typeof input.message_ts !== 'string' || !SLACK_TS.test(input.message_ts)) fail('Ask Slack citation message_ts is invalid');
  if (Object.hasOwn(input, 'thread_ts') && (typeof input.thread_ts !== 'string' || !SLACK_TS.test(input.thread_ts))) fail('Ask Slack citation thread_ts is invalid');
  if (typeof input.permalink !== 'string' || input.permalink.length > 512 || !SLACK_PERMALINK.test(input.permalink)) fail('Ask Slack citation permalink is invalid');
  assertDigest(input.text_sha256, 'Ask Slack citation text_sha256');
  return Object.freeze({
    kind: 'slack_message', team_id: input.team_id, channel_id: input.channel_id, message_ts: input.message_ts,
    ...(Object.hasOwn(input, 'thread_ts') ? { thread_ts: input.thread_ts as string } : {}),
    permalink: input.permalink, text_sha256: input.text_sha256 as `sha256:${string}`,
  });
}

/** The Ask answer versions these validators serve; each admits every citation kind of the one before it. */
type AnswerVersion = 4 | 5 | 6 | 7 | 8;

/** A workspace item or tool container: the V8 answer's own kinds (research tool contract v1). */
function workspaceKind(value: unknown): boolean {
  return (PERSON_WORKSPACE_CITATION_KINDS_V1 as readonly unknown[]).includes(value);
}

function evidenceCitation(value: unknown, version: AnswerVersion = 4): PersonAnswerEvidenceCitationV8 {
  const input = object(value, 'Ask citation');
  if (version >= 5 && input.kind === 'ticket') return validatePersonTicketCitationV1(input);
  if (version >= 6 && input.kind === 'page') return validatePersonPageCitationV1(input);
  if (version >= 7 && input.kind === 'follow_up') return validatePersonFollowUpCitationV1(input);
  if (version >= 8 && workspaceKind(input.kind)) return validatePersonWorkspaceCitationV1(input);
  return input.kind === 'slack_message' ? slackCitation(input) : citation(input);
}

function citation(value: unknown): PersonAnswerCitationV3 {
  const input = object(value, 'Ask citation');
  if (input.kind === 'approved_record') {
    assertExactKeys(input, ['kind', 'atom_id', 'record_sha256', 'policy_id'], 'Ask citation');
    assertDigest(input.atom_id, 'Ask approved-record citation atom_id');
    assertDigest(input.record_sha256, 'Ask approved-record citation record_sha256');
    if (!['organization-member-readable-person-v2', 'restricted-reviewer-person-v2', 'project-members-readable-person-v1'].includes(input.policy_id as string)) fail('Ask approved-record citation policy_id is invalid');
    return Object.freeze({ kind: 'approved_record', atom_id: input.atom_id as `sha256:${string}`, record_sha256: input.record_sha256 as `sha256:${string}`, policy_id: input.policy_id as ApprovedRecordPolicyV3 });
  }
  if (input.kind === 'source_revision') {
    const keys = ['kind', 'source_id', 'revision_id', 'source_sha256', 'representation_sha256', 'anchor_sha256', ...(Object.hasOwn(input, 'document_id') ? ['document_id'] : []), ...(Object.hasOwn(input, 'label') ? ['label'] : [])];
    assertExactKeys(input, keys, 'Ask citation');
    if (typeof input.source_id !== 'string' || !/^source:[a-f0-9]{64}$/.test(input.source_id)) fail('Ask source citation source_id is invalid');
    coordinateText(input.revision_id, 'Ask source citation revision_id', 512);
    assertDigest(input.source_sha256, 'Ask source citation source_sha256');
    assertDigest(input.representation_sha256, 'Ask source citation representation_sha256');
    assertDigest(input.anchor_sha256, 'Ask source citation anchor_sha256');
    const document_id = Object.hasOwn(input, 'document_id') ? validatePersonDocumentIdV1(input.document_id) : undefined;
    if (Object.hasOwn(input, 'label')) coordinateText(input.label, 'Ask source citation label', 200);
    return Object.freeze({
      kind: 'source_revision', source_id: input.source_id as `source:${string}`, revision_id: input.revision_id as string,
      source_sha256: input.source_sha256 as `sha256:${string}`, representation_sha256: input.representation_sha256 as `sha256:${string}`,
      anchor_sha256: input.anchor_sha256 as `sha256:${string}`,
      ...(document_id === undefined ? {} : { document_id }), ...(Object.hasOwn(input, 'label') ? { label: input.label as string } : {}),
    });
  }
  fail('Ask citation kind is invalid');
}

/**
 * The identity an Ask response checks for duplicate citations: a response cites each key once. A page's section and
 * version are part of it; a ticket's or a follow-up's released text is not, so a listed ticket's row and its opened body
 * are one citation. A renderer that numbers citations uses this key so it never builds a response this refuses.
 */
export function personAnswerCitationKeyV7(value: PersonAnswerEvidenceCitationV7): string {
  return citationKey(value);
}

/**
 * `personAnswerCitationKeyV7` for the V8 answer: a project, a person and a tool by their ids, and a tool container by
 * its tool, scope, kind and container id, never by its label or key.
 */
export function personAnswerCitationKeyV8(value: PersonAnswerEvidenceCitationV8): string {
  return citationKey(value);
}

function citationKey(value: PersonAnswerEvidenceCitationV8): string {
  if (value.kind === 'project') return `project:${value.project_id}`;
  if (value.kind === 'person') return `person:${value.membership_id}`;
  if (value.kind === 'tool') return `tool:${value.tool_id}`;
  // Its scope and container ids are free text: the JSON array keeps two containers apart even when one holds a colon.
  if (value.kind === 'tool_container') return `tool_container:${JSON.stringify([value.tool_id, value.external_scope_id, value.container, value.container_id])}`;
  if (value.kind === 'follow_up') return `follow_up:${value.item_id}`;
  if (value.kind === 'page') return `page:${value.tool_id}:${value.external_scope_id}:${value.page_id}:${value.section_id}:${value.version}`;
  if (value.kind === 'ticket') return `ticket:${value.tool_id}:${value.external_scope_id}:${value.ticket_id}`;
  if (value.kind === 'slack_message') return `slack_message:${value.team_id}:${value.channel_id}:${value.message_ts}`;
  return value.kind === 'approved_record'
    ? `approved_record:${value.atom_id}`
    : `source_revision:${value.source_id}:${value.revision_id}:${value.representation_sha256}:${value.anchor_sha256}`;
}

function evidenceKind(value: unknown, label: string, version: AnswerVersion = 4): asserts value is PersonEvidenceKindV5 {
  if (version >= 8 && workspaceKind(value)) return;
  if (version >= 7 && value === 'follow_up') return;
  if (version >= 6 && value === 'page') return;
  if (version >= 5 && value === 'ticket') return;
  if (!['imported_meeting', 'decision', 'action', 'rationale', 'note', 'document_passage', 'slack_message'].includes(value as string)) fail(`${label} is invalid`);
}

function visibility(value: unknown, label: string): asserts value is PersonEvidenceVisibilityV1 {
  if (!['only_me', 'team', 'project', 'projects', 'approver_only'].includes(value as string)) fail(`${label} is invalid`);
}

function statement(value: unknown, citations: readonly (PersonAnswerCitationV5 | PersonAnswerCitationV6 | PersonAnswerCitationV7 | PersonAnswerCitationV8)[], label: string, fallback = false): PersonAnswerStatementV4 {
  const input = object(value, label);
  assertExactKeys(input, ['text', 'citation_indexes', 'private'], label);
  if (fallback) evidenceText(input.text, `${label} text`, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1);
  else text(input.text, `${label} text`, 4 * 1024, true);
  if (!Array.isArray(input.citation_indexes) || input.citation_indexes.length === 0 || input.citation_indexes.length > 40 || typeof input.private !== 'boolean') fail(`${label} is invalid`);
  const indexes = input.citation_indexes.map((index) => {
    if (!Number.isSafeInteger(index) || index < 0 || index >= citations.length) fail(`${label} citation_indexes is invalid`);
    return index;
  });
  if (new Set(indexes).size !== indexes.length) fail(`${label} citation_indexes contains duplicates`);
  const expectedPrivate = indexes.some((index) => ['only_me', 'approver_only'].includes(citations[index]!.visibility));
  if (input.private !== expectedPrivate) fail(`${label} private is inconsistent with cited visibility`);
  return Object.freeze({ text: input.text as string, citation_indexes: Object.freeze(indexes), private: input.private });
}

/**
 * A citation's ref names the item it cites: its record, its document, its note or shared transcript, its follow-up, or
 * its project or tool. A person and a tool container have no ref.
 */
function citationRefConsistent(cited: PersonAnswerEvidenceCitationV8, ref: PersonAnswerOpenRefV8): boolean {
  if (cited.kind === 'project') return ref === `project:${cited.project_id}`;
  if (cited.kind === 'tool') return ref === `tool:${cited.tool_id}`;
  if (cited.kind === 'person' || cited.kind === 'tool_container') return false;
  if (ref.startsWith('project:') || ref.startsWith('tool:')) return false;
  if (cited.kind === 'follow_up') return ref === `follow_up:${cited.item_id}`;
  if (ref.startsWith('follow_up:')) return false;
  if (cited.kind === 'approved_record') return ref === `meeting:${cited.record_sha256}`;
  if (cited.kind === 'source_revision') {
    return cited.document_id === undefined
      ? ref.startsWith('imported_meeting:') || ref.startsWith('note:') || ref.startsWith('transcript:')
      : ref === `document:${cited.document_id}`;
  }
  return false;
}

function answerCitation(value: unknown, version: AnswerVersion = 4): PersonAnswerCitationV8 {
  const input = object(value, 'Ask response citation');
  assertExactKeys(input, ['citation', 'kind', 'label', 'visibility', ...(Object.hasOwn(input, 'ref') ? ['ref'] : []), ...(version >= 8 && Object.hasOwn(input, 'key') ? ['key'] : [])], 'Ask response citation');
  evidenceKind(input.kind, 'Ask response citation kind', version);
  text(input.label, 'Ask response citation label', PERSON_EVIDENCE_LABEL_MAX_BYTES_V1);
  visibility(input.visibility, 'Ask response citation visibility');
  const cited = evidenceCitation(input.citation, version);
  if ((cited.kind === 'ticket') !== (input.kind === 'ticket')) fail('Ticket citation kind is inconsistent');
  if ((cited.kind === 'page') !== (input.kind === 'page')) fail('Page citation kind is inconsistent');
  if ((cited.kind === 'slack_message') !== (input.kind === 'slack_message')) fail('Ask response citation kind is inconsistent');
  if ((cited.kind === 'follow_up') !== (input.kind === 'follow_up')) fail('Follow-up citation kind is inconsistent');
  for (const kind of PERSON_WORKSPACE_CITATION_KINDS_V1) if ((cited.kind === kind) !== (input.kind === kind)) fail('Workspace citation kind is inconsistent');
  const ref: PersonAnswerOpenRefV8 | undefined = !Object.hasOwn(input, 'ref') ? undefined
    : version >= 7 && typeof input.ref === 'string' && input.ref.startsWith('follow_up:') ? validatePersonFollowUpRefV1(input.ref, 'Ask response citation ref')
      : version >= 8 && typeof input.ref === 'string' && (input.ref.startsWith('project:') || input.ref.startsWith('tool:')) ? validatePersonWorkspaceRefV1(input.ref, 'Ask response citation ref')
        : validatePersonOpenRefV1(input.ref, 'Ask response citation ref');
  // A follow-up always opens its item page.
  if (cited.kind === 'follow_up' && ref === undefined) fail('Follow-up citation ref is missing');
  // A project always opens in ECHO, and a tool on the tools page; a person and a tool container open no page of ECHO's.
  if ((cited.kind === 'project' || cited.kind === 'tool') && ref === undefined) fail('Workspace citation ref is missing');
  if (ref !== undefined && !citationRefConsistent(cited, ref)) fail('Ask response citation ref is inconsistent');
  if (Object.hasOwn(input, 'key')) {
    if (cited.kind !== 'tool_container') fail('Ask response citation key applies only to a tool container');
    text(input.key, 'Ask response citation key', 256);
  }
  return Object.freeze({
    citation: cited, kind: input.kind, label: input.label as string, visibility: input.visibility, ...(ref === undefined ? {} : { ref }),
    ...(Object.hasOwn(input, 'key') ? { key: input.key as string } : {}),
  });
}

function part(value: unknown, citations: readonly (PersonAnswerCitationV5 | PersonAnswerCitationV6 | PersonAnswerCitationV7 | PersonAnswerCitationV8)[]): PersonAnswerPartV4 {
  const input = object(value, 'Ask response part');
  assertExactKeys(input, ['question', 'status', 'statements', ...(Object.hasOwn(input, 'gap') ? ['gap'] : []), ...(Object.hasOwn(input, 'records') ? ['records'] : [])], 'Ask response part');
  text(input.question, 'Ask response part question', 1024);
  if (!['answered', 'partial', 'not_found', 'records_only'].includes(input.status as string) || !Array.isArray(input.statements) || input.statements.length > PERSON_ANSWER_MAX_STATEMENTS_PER_PART_V4) fail('Ask response part is invalid');
  if (Object.hasOwn(input, 'gap')) text(input.gap, 'Ask response part gap', 2 * 1024, true);
  if (Object.hasOwn(input, 'records') && (!Array.isArray(input.records) || input.records.length > 40)) fail('Ask response part records is invalid');
  return Object.freeze({
    question: input.question as string,
    status: input.status as PersonAnswerPartV4['status'],
    statements: Object.freeze(input.statements.map((item) => statement(item, citations, 'Ask response statement'))),
    ...(Object.hasOwn(input, 'gap') ? { gap: input.gap as string } : {}),
    ...(Object.hasOwn(input, 'records') ? { records: Object.freeze((input.records as unknown[]).map((item) => statement(item, citations, 'Ask response fallback record', true))) } : {}),
  });
}

function deskItem(value: unknown) {
  const input = object(value, 'Evidence desk item');
  assertExactKeys(input, ['id', 'citation', 'kind', 'label', 'visibility', 'receipt_sha256', ...(Object.hasOwn(input, 'text') ? ['text'] : []), ...(Object.hasOwn(input, 'attributes') ? ['attributes'] : []), ...(Object.hasOwn(input, 'occurred_at') ? ['occurred_at'] : [])], 'Evidence desk item');
  if (Object.hasOwn(input, 'occurred_at') && (typeof input.occurred_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.occurred_at))) fail('Evidence desk item occurred_at is invalid');
  text(input.id, 'Evidence desk item id', 512);
  evidenceKind(input.kind, 'Evidence desk item kind');
  text(input.label, 'Evidence desk item label', PERSON_EVIDENCE_LABEL_MAX_BYTES_V1);
  visibility(input.visibility, 'Evidence desk item visibility');
  assertDigest(input.receipt_sha256, 'Evidence desk item receipt_sha256');
  if (Object.hasOwn(input, 'text')) evidenceText(input.text, 'Evidence desk item text', PERSON_EVIDENCE_TEXT_MAX_BYTES_V1);
  let attributes: PersonEvidenceAttributesV1 | undefined;
  if (Object.hasOwn(input, 'attributes')) {
    const raw = object(input.attributes, 'Evidence desk item attributes');
    assertExactKeys(raw, [...(Object.hasOwn(raw, 'owner') ? ['owner'] : []), ...(Object.hasOwn(raw, 'due_at') ? ['due_at'] : []), ...(Object.hasOwn(raw, 'status') ? ['status'] : [])], 'Evidence desk item attributes');
    if (Object.keys(raw).length === 0) fail('Evidence desk item attributes is invalid');
    if (Object.hasOwn(raw, 'owner')) text(raw.owner, 'Evidence desk item owner', 512);
    if (Object.hasOwn(raw, 'due_at')) text(raw.due_at, 'Evidence desk item due_at', 128);
    if (Object.hasOwn(raw, 'status')) text(raw.status, 'Evidence desk item status', 128);
    attributes = Object.freeze({ ...(Object.hasOwn(raw, 'owner') ? { owner: raw.owner as string } : {}), ...(Object.hasOwn(raw, 'due_at') ? { due_at: raw.due_at as string } : {}), ...(Object.hasOwn(raw, 'status') ? { status: raw.status as string } : {}) });
  }
  const cited = evidenceCitation(input.citation);
  if ((cited.kind === 'slack_message') !== (input.kind === 'slack_message')) fail('Evidence desk item kind is inconsistent');
  return Object.freeze({ id: input.id as string, citation: cited, kind: input.kind, ...(Object.hasOwn(input, 'text') ? { text: input.text as string } : {}), label: input.label as string, visibility: input.visibility, ...(attributes === undefined ? {} : { attributes }), ...(Object.hasOwn(input, 'occurred_at') ? { occurred_at: input.occurred_at as string } : {}), receipt_sha256: input.receipt_sha256 as `sha256:${string}` });
}

function boundedRequest<T>(result: T, label: string): T {
  if (canonicalJsonBytes(result).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`);
  return Object.freeze(result);
}

export function validatePersonAnswerRequestV3(value: unknown): PersonAnswerRequestV3 {
  const input = object(value, 'Ask request');
  assertExactKeys(input, ['schema_version', 'question', ...(Object.hasOwn(input, 'project_id') ? ['project_id'] : []), ...(Object.hasOwn(input, 'mine') ? ['mine'] : []), ...(Object.hasOwn(input, 'capture_id') ? ['capture_id'] : [])], 'Ask request');
  if (input.schema_version !== 3) fail('Ask request schema_version is unsupported');
  if (Object.hasOwn(input, 'mine') && (input.mine !== true || Object.hasOwn(input, 'project_id'))) fail('Ask request scope is invalid');
  return boundedRequest({ schema_version: 3 as const, question: validatePersonQueryText(input.question), ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Ask request project_id') } : {}), ...(Object.hasOwn(input, 'mine') ? { mine: true as const } : {}), ...(Object.hasOwn(input, 'capture_id') ? { capture_id: validatePersonDiagnosticCaptureIdV1(input.capture_id) } : {}) }, 'Ask request');
}

/** One V6 response citation, as the impact card (person-impact-card-v1.ts) cites items too. */
export function validatePersonAnswerCitationV6(value: unknown): PersonAnswerCitationV6 { return answerCitation(value, 6) as PersonAnswerCitationV6; }
/** One V7 response citation: a V6 citation, or a follow-up with its follow-up ref (ADR-0040). */
export function validatePersonAnswerCitationV7(value: unknown): PersonAnswerCitationV7 { return answerCitation(value, 7) as PersonAnswerCitationV7; }
/**
 * One V8 response citation (research tool contract v1): a V7 citation, a project or a tool with the ref that opens it,
 * a person, or a tool container with its key when it has one.
 */
export function validatePersonAnswerCitationV8(value: unknown): PersonAnswerCitationV8 { return answerCitation(value, 8); }
export function validatePersonAnswerResponseV4(value: unknown): PersonAnswerResponseV4 { return answerResponse(value, 4) as PersonAnswerResponseV4; }
export function validatePersonAnswerResponseV5(value: unknown): PersonAnswerResponseV5 { return answerResponse(value, 5) as PersonAnswerResponseV5; }
export function validatePersonAnswerResponseV6(value: unknown): PersonAnswerResponseV6 { return answerResponse(value, 6) as PersonAnswerResponseV6; }
export function validatePersonAnswerResponseV7(value: unknown): PersonAnswerResponseV7 { return answerResponse(value, 7) as PersonAnswerResponseV7; }
export function validatePersonAnswerResponseV8(value: unknown): PersonAnswerResponseV8 { return answerResponse(value, 8) as PersonAnswerResponseV8; }
function answerResponse(value: unknown, version: AnswerVersion) {
  const input = object(value, 'Ask response');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'outcome', 'citations', 'parts', ...(Object.hasOwn(input, 'direct') ? ['direct'] : []), ...(Object.hasOwn(input, 'assumption') ? ['assumption'] : []), ...(Object.hasOwn(input, 'notice') ? ['notice'] : [])], 'Ask response');
  if (input.schema_version !== version || input.kind !== `echo-clean-person-answer-v${version}` || !['answered', 'partial', 'not_found', 'off_scope'].includes(input.outcome as string) || !Array.isArray(input.citations) || input.citations.length > 40 || !Array.isArray(input.parts) || input.parts.length < 1 || input.parts.length > 5) fail('Ask response is invalid');
  if (Object.hasOwn(input, 'assumption')) text(input.assumption, 'Ask response assumption', 2 * 1024, true);
  if (Object.hasOwn(input, 'notice')) text(input.notice, 'Ask response notice', 2 * 1024, true);
  const citations = input.citations.map(item => answerCitation(item, version));
  const citationKeys = new Set<string>();
  for (const item of citations) { const key = citationKey(item.citation); if (citationKeys.has(key)) fail('Ask response contains duplicate citations'); citationKeys.add(key); }
  const result = {
    schema_version: version, kind: `echo-clean-person-answer-v${version}`, scope: scope(input.scope), outcome: input.outcome as PersonAnswerResponseV4['outcome'], citations: Object.freeze(citations),
    ...(Object.hasOwn(input, 'direct') ? { direct: statement(input.direct, citations, 'Ask response direct') } : {}),
    parts: Object.freeze(input.parts.map((item) => part(item, citations))),
    ...(Object.hasOwn(input, 'assumption') ? { assumption: input.assumption as string } : {}), ...(Object.hasOwn(input, 'notice') ? { notice: input.notice as string } : {}),
  };
  for (const item of result.parts) {
    if (item.status === 'answered' && (item.statements.length === 0 || item.gap !== undefined || item.records !== undefined)) fail('Answered part is inconsistent');
    if (item.status === 'partial' && (item.statements.length === 0 || item.records !== undefined)) fail('Partial part is inconsistent');
    if (item.status === 'not_found' && (item.statements.length !== 0 || item.records !== undefined)) fail('Not-found part is inconsistent');
    if (item.status === 'records_only' && (item.statements.length !== 0 || item.records === undefined || item.records.length === 0)) fail('Records-only part is inconsistent');
  }
  if (result.outcome === 'answered' && result.parts.some((item) => item.status === 'partial' || item.status === 'not_found')) fail('Answered outcome is inconsistent');
  if (result.outcome === 'partial' && !result.parts.some((item) => item.status === 'partial' || item.status === 'not_found' || item.status === 'records_only')) fail('Partial outcome is inconsistent');
  if ((result.outcome === 'not_found' || result.outcome === 'off_scope') && (result.direct !== undefined || result.citations.length !== 0 || result.parts.some((item) => item.status !== 'not_found' || item.statements.length !== 0 || item.records !== undefined))) fail('No-evidence outcome is inconsistent');
  if (canonicalJsonBytes(result).byteLength > PERSON_ANSWER_RESPONSE_MAX_BYTES_V4) fail('Ask response exceeds JSON byte bound');
  return Object.freeze(result);
}

export function validatePersonEvidenceSearchRequestV1(value: unknown): PersonEvidenceSearchRequestV1 {
  const input = object(value, 'Evidence search request');
  assertExactKeys(input, ['schema_version', ...(Object.hasOwn(input, 'query') ? ['query'] : []), ...(Object.hasOwn(input, 'kinds') ? ['kinds'] : []), ...(Object.hasOwn(input, 'limit') ? ['limit'] : []), ...(Object.hasOwn(input, 'project_id') ? ['project_id'] : [])], 'Evidence search request');
  if (input.schema_version !== 1) fail('Evidence search request schema_version is unsupported');
  if (Object.hasOwn(input, 'kinds') && (!Array.isArray(input.kinds) || input.kinds.length === 0 || input.kinds.length > 6)) fail('Evidence search request kinds is invalid');
  const kinds = Object.hasOwn(input, 'kinds') ? (input.kinds as unknown[]).map((kind) => { evidenceKind(kind, 'Evidence search request kind'); return kind as PersonEvidenceKindV1; }) : undefined;
  if (kinds !== undefined && new Set(kinds).size !== kinds.length) fail('Evidence search request kinds contains duplicates');
  const maximumLimit = Object.hasOwn(input, 'query') ? 10 : 50;
  if (Object.hasOwn(input, 'limit') && (!Number.isSafeInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > maximumLimit)) fail('Evidence search request limit is invalid');
  return boundedRequest({ schema_version: 1 as const, ...(Object.hasOwn(input, 'query') ? { query: validatePersonQueryText(input.query) } : {}), ...(kinds === undefined ? {} : { kinds: Object.freeze(kinds) }), ...(Object.hasOwn(input, 'limit') ? { limit: input.limit as number } : {}), ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Evidence search request project_id') } : {}) }, 'Evidence search request');
}

export function validatePersonEvidenceOpenRequestV1(value: unknown): PersonEvidenceOpenRequestV1 {
  const input = object(value, 'Evidence open request');
  assertExactKeys(input, ['schema_version', 'citation', ...(Object.hasOwn(input, 'neighbours') ? ['neighbours'] : []), ...(Object.hasOwn(input, 'project_id') ? ['project_id'] : [])], 'Evidence open request');
  if (input.schema_version !== 1 || (Object.hasOwn(input, 'neighbours') && (!Number.isSafeInteger(input.neighbours) || (input.neighbours as number) < 0 || (input.neighbours as number) > 2))) fail('Evidence open request is invalid');
  return boundedRequest({ schema_version: 1 as const, citation: citation(input.citation), ...(Object.hasOwn(input, 'neighbours') ? { neighbours: input.neighbours as 0 | 1 | 2 } : {}), ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Evidence open request project_id') } : {}) }, 'Evidence open request');
}

export function validatePersonEvidenceDeskResponseV1(value: unknown): PersonEvidenceDeskResponseV1 {
  const input = object(value, 'Evidence desk response');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'items', 'truncated', ...(Object.hasOwn(input, 'notice') ? ['notice'] : [])], 'Evidence desk response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-evidence-desk-v1' || !Array.isArray(input.items) || input.items.length > 50 || typeof input.truncated !== 'boolean') fail('Evidence desk response is invalid');
  if (Object.hasOwn(input, 'notice')) text(input.notice, 'Evidence desk response notice', 2 * 1024, true);
  const items = input.items.map(item => deskItem(item));
  const ids = new Set<string>(); const coordinates = new Set<string>();
  for (const item of items) { if (ids.has(item.id)) fail('Evidence desk response contains duplicate item IDs'); ids.add(item.id); const key = citationKey(item.citation); if (coordinates.has(key)) fail('Evidence desk response contains duplicate citations'); coordinates.add(key); }
  const result = { schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: scope(input.scope), items: Object.freeze(items), truncated: input.truncated, ...(Object.hasOwn(input, 'notice') ? { notice: input.notice as string } : {}) };
  if (canonicalJsonBytes(result).byteLength > PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1) fail('Evidence desk response exceeds JSON byte bound');
  return Object.freeze(result) as PersonEvidenceDeskResponseV1;
}

export function validatePersonCapabilitiesV1(value: unknown): PersonCapabilitiesV1 {
  const input = object(value, 'Person capabilities');
  assertExactKeys(input, ['schema_version', 'kind', 'agentic_ask_v1'], 'Person capabilities');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-capabilities-v1' || typeof input.agentic_ask_v1 !== 'boolean') fail('Person capabilities is invalid');
  return Object.freeze({ schema_version: 1, kind: 'echo-person-capabilities-v1', agentic_ask_v1: input.agentic_ask_v1 });
}

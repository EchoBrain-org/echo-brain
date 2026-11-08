import { validatePersonDiagnosticCaptureIdV1, type PersonDiagnosticCaptureIdV1 } from './person-diagnostics-v1.js';
import { validatePersonTicketCitationV1 } from './person-ticket-citation-v1.js';
import { validatePersonPageCitationV1 } from './person-page-citation-v1.js';
import {
  PERSON_ANSWER_OUTCOMES_V8, validatePersonWorkspaceRefV1, type PersonAnswerCitationV8, type PersonAnswerEvidenceCitationV8, type PersonAnswerOpenRefV8, type PersonAnswerResponseV8,
  type PersonAnswerCitationV6, type PersonEvidenceKindV5,
} from './person-answer-v8.js';
import { validatePersonFollowUpCitationV1, validatePersonFollowUpRefV1 } from './person-follow-up-evidence-v1.js';
import { validatePersonWorkspaceCitationV1 } from './person-workspace-citation-v1.js';
import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonQueryText } from './person-query.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import { validatePersonAnswerScopeV3, validatePersonSourceRevisionCitationV1, type PersonAnswerCitationV3, type PersonAnswerScopeV3 } from './person-answer-v3.js';
import { validatePersonItemRefV1, type PersonItemRefV1 } from './person-list-v1.js';
import { validatePersonAnswerBlocksV2, type PersonAnswerBlockV2 } from './person-answer-layout-v2.js';
import {
  PERSON_ANSWER_CHOICE_LABEL_MAX_CHARS_V1,
  PERSON_ANSWER_CHOICES_MAX_V1,
  PERSON_ANSWER_CHOICES_MIN_V1,
  PERSON_ANSWER_PREVIOUS_MAX_CITATIONS_V1,
  PERSON_ANSWER_PREVIOUS_MAX_STATEMENTS_V1,
  PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1,
  PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CITATIONS_V1,
  PERSON_ANSWER_SINCE_MAX_STATEMENTS_V1,
  type PersonAnswerChoiceV1,
  type PersonAnswerPreviousStatementV1,
  type PersonAnswerPreviousV1,
  type PersonAnswerSinceV1,
} from './person-answer-previous-v1.js';
import {
  asEnumerableRecord as object,
  assertDigest,
  assertEvidenceText as evidenceText,
  assertExactKeys,
  assertTimestamp,
  boundedLine,
  boundedList,
  fail,
  MAX_ORGANIZATION_API_BODY_BYTES,
  oneOf,
  utf8ByteLength,
} from './validation.js';

/** A statement's text: one claim, within 4 KiB. */
export const PERSON_ANSWER_STATEMENT_MAX_BYTES_V4 = 4 * 1024;
/** The citations one statement may carry, in an answer of any length (ADR-0051 lifts only an answer's own count). */
export const PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4 = 40;
/**
 * The evidence desk search (ADR-0022). Ask itself is `/v7` with the V8 answer (person-answer-v8.ts): the Ask routes before
 * it, `/v3` to `/v6` with the V4 to V7 answers, were retired, and so were the capability read and the desk's open.
 */
export const PERSON_EVIDENCE_SEARCH_PATH_V1 = '/v3/person/evidence/search';

/** Optional Ask headers; older Authorities ignore them, preserving client-first upgrades. */
export const PERSON_ASK_CLIENT_NOW_HEADER_V1 = 'x-echo-client-now';
export const PERSON_ASK_TIME_ZONE_HEADER_V1 = 'x-echo-time-zone';
/** Only opted-in clients receive typed Ask explanations; older exact-key V8 readers keep their response shape. */
export const PERSON_ASK_GAP_DETAILS_HEADER_V1 = 'x-echo-ask-gap-details';
export const PERSON_ASK_GAP_DETAILS_HEADER_VALUE_V1 = '1';
export function validatePersonAskGapDetailsHeaderV1(value: unknown): true | undefined {
  if (value === undefined) return undefined;
  if (value === PERSON_ASK_GAP_DETAILS_HEADER_VALUE_V1) return true;
  fail('Ask gap details header is invalid');
}

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

export type PersonEvidenceKindV1 = 'imported_meeting' | 'decision' | 'action' | 'rationale' | 'note' | 'document_passage';
export type PersonEvidenceVisibilityV1 = 'only_me' | 'team' | 'project' | 'projects' | 'approver_only';
type ApprovedRecordPolicyV3 = Extract<PersonAnswerCitationV3, { readonly kind: 'approved_record' }>['policy_id'];

/** Every citation an Ask answer or an evidence desk item may carry. Open requests stay V3-only. */
export type PersonAnswerEvidenceCitationV4 = PersonAnswerCitationV3;

export interface PersonAnswerRequestV3 {
  readonly schema_version: 3;
  readonly question: string;
  readonly project_id?: ProjectIdV1;
  /** A capture prepared by this actor for this ordinary Ask. */
  readonly capture_id?: PersonDiagnosticCaptureIdV1;
  /** The asker's previous turn (ADR-0047): the asker's own context, never evidence, and never stored. */
  readonly previous?: PersonAnswerPreviousV1;
}

export interface PersonAnswerStatementV4 {
  readonly text: string;
  readonly citation_indexes: readonly number[];
  readonly private: boolean;
}

/** Deterministic evidence fallback when a per-part writer cannot produce prose. */
export type PersonAnswerEvidenceFallbackV4 = PersonAnswerStatementV4;

/** Actionable explanations, independent of the diagnostic gap's coverage/formatting notes. */
export interface PersonAnswerGapDetailsV1 {
  readonly unsupported_action?: true;
  readonly interrupted?: true;
  readonly not_found?: string;
}

export function validatePersonAnswerGapDetailsV1(value: unknown): PersonAnswerGapDetailsV1 {
  const input = object(value, 'Ask gap details');
  const keys = ['unsupported_action', 'interrupted', 'not_found'].filter(key => Object.hasOwn(input, key));
  assertExactKeys(input, keys, 'Ask gap details');
  if (keys.length === 0) fail('Ask gap details is empty');
  for (const flag of ['unsupported_action', 'interrupted']) if (Object.hasOwn(input, flag) && input[flag] !== true) fail('Ask gap flag must be true');
  if (Object.hasOwn(input, 'not_found')) text(input.not_found, 'Ask not-found explanation', 2 * 1024, true);
  return Object.freeze({ ...(input.unsupported_action === true ? { unsupported_action: true as const } : {}),
    ...(input.interrupted === true ? { interrupted: true as const } : {}), ...(Object.hasOwn(input, 'not_found') ? { not_found: input.not_found as string } : {}) });
}

export interface PersonAnswerPartV4 {
  readonly question: string;
  readonly status: 'answered' | 'partial' | 'not_found' | 'records_only';
  readonly statements: readonly PersonAnswerStatementV4[];
  readonly gap?: string;
  readonly gap_details?: PersonAnswerGapDetailsV1;
  readonly records?: readonly PersonAnswerEvidenceFallbackV4[];
  /** The blocks its statements read as (answer layout v2, ADR-0051): on every part with statements, and on no other. */
  readonly blocks?: readonly PersonAnswerBlockV2[];
}

/** An answer citation's projection: what later citations (V6 to V8) extend. */
export interface PersonAnswerCitationV4 {
  readonly citation: PersonAnswerEvidenceCitationV4;
  readonly kind: PersonEvidenceKindV1;
  readonly label: string;
  readonly visibility: PersonEvidenceVisibilityV1;
  /** Opens the cited item with person open (ADR-0024). */
  readonly ref?: PersonItemRefV1;
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
  /** YYYY-MM-DD when the source knows the date. */
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

function text(value: unknown, label: string, maximumBytes: number, multiline = false): asserts value is string {
  const controls = multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u : /[\p{Cc}\p{Zl}\p{Zp}]/u;
  if (
    typeof value !== 'string' || value.length === 0 || value.trim() !== value ||
    value !== value.normalize('NFC') || controls.test(value) || utf8ByteLength(value) > maximumBytes
  ) fail(`${label} is invalid`);
}

function scope(value: unknown): PersonAnswerScopeV3 {
  return validatePersonAnswerScopeV3(value, 'Ask response scope');
}

/**
 * The citations these validators serve, each admitting every kind of the one before it: 4, the evidence desk's (records
 * and passages); 6, the impact card's (with tickets and pages); 8, the Ask answer's (with follow-ups, the workspace and
 * tool containers).
 */
type CitationVersion = 4 | 6 | 8;
type CitedKind = PersonAnswerEvidenceCitationV8['kind'];

/**
 * One row per citation kind, read by every per-kind rule: the first version that admits it, its exact validator, the
 * identity a response cites once, the label of the kind an answer citation names it by when it has its own (the two are
 * that kind together or not at all), and the ref that names its item (none: no ref is consistent), which `ref_required`
 * makes its answer citation carry.
 */
interface CitationKindRow<C> {
  readonly since: CitationVersion;
  validate(input: Record<string, unknown>): PersonAnswerEvidenceCitationV8;
  key(value: C): string;
  readonly named?: 'Ticket' | 'Page' | 'Follow-up' | 'Workspace';
  opens?(value: C, ref: PersonAnswerOpenRefV8): boolean;
  readonly ref_required?: true;
}

const CITATION_KINDS: { readonly [K in CitedKind]: CitationKindRow<Extract<PersonAnswerEvidenceCitationV8, { readonly kind: K }>> } = {
  approved_record: { since: 4, validate: approvedRecordCitation, key: value => `approved_record:${value.atom_id}`, opens: (value, ref) => ref === `meeting:${value.record_sha256}` },
  // A document's passage opens its document; a note's or an imported meeting's opens that note or meeting.
  source_revision: {
    since: 4, validate: input => validatePersonSourceRevisionCitationV1(input, 'optional'),
    key: value => `source_revision:${value.source_id}:${value.revision_id}:${value.representation_sha256}:${value.anchor_sha256}`,
    opens: (value, ref) => value.document_id === undefined ? ref.startsWith('imported_meeting:') || ref.startsWith('note:') : ref === `document:${value.document_id}`,
  },
  // A ticket's released text is not part of its identity, so a listed ticket's row and its opened body are one citation.
  ticket: { since: 6, validate: validatePersonTicketCitationV1, named: 'Ticket', key: value => `ticket:${value.tool_id}:${value.external_scope_id}:${value.ticket_id}` },
  // A page's section and version are part of its identity.
  page: { since: 6, validate: validatePersonPageCitationV1, named: 'Page', key: value => `page:${value.tool_id}:${value.external_scope_id}:${value.page_id}:${value.section_id}:${value.version}` },
  // A follow-up always opens its item page.
  follow_up: { since: 8, validate: validatePersonFollowUpCitationV1, named: 'Follow-up', key: value => `follow_up:${value.item_id}`, opens: (value, ref) => ref === `follow_up:${value.item_id}`, ref_required: true },
  // A project always opens in ECHO, and a tool on the tools page; a person and a tool container open no page of ECHO's.
  project: { since: 8, validate: validatePersonWorkspaceCitationV1, named: 'Workspace', key: value => `project:${value.project_id}`, opens: (value, ref) => ref === `project:${value.project_id}`, ref_required: true },
  person: { since: 8, validate: validatePersonWorkspaceCitationV1, named: 'Workspace', key: value => `person:${value.membership_id}` },
  tool: { since: 8, validate: validatePersonWorkspaceCitationV1, named: 'Workspace', key: value => `tool:${value.tool_id}`, opens: (value, ref) => ref === `tool:${value.tool_id}`, ref_required: true },
  // Its scope and container ids are free text: the JSON array keeps two containers apart even when one holds a colon.
  tool_container: {
    since: 8, validate: validatePersonWorkspaceCitationV1, named: 'Workspace',
    key: value => `tool_container:${JSON.stringify([value.tool_id, value.external_scope_id, value.container, value.container_id])}`,
  },
};

/** The row of a citation kind, if `kind` names one (never a prototype key). */
function citationKind(kind: unknown): CitationKindRow<PersonAnswerEvidenceCitationV8> | undefined {
  return typeof kind === 'string' && Object.hasOwn(CITATION_KINDS, kind) ? CITATION_KINDS[kind as CitedKind] as CitationKindRow<PersonAnswerEvidenceCitationV8> : undefined;
}

function evidenceCitation(value: unknown, version: CitationVersion = 4): PersonAnswerEvidenceCitationV8 {
  const input = object(value, 'Ask citation');
  const kind = citationKind(input.kind);
  if (kind === undefined || kind.since > version) fail('Ask citation kind is invalid');
  return kind.validate(input);
}

/** One V8 evidence citation, exactly as a response citation's `citation` carries it; the Ask source check reads these (ADR-0047). */
export function validatePersonAnswerEvidenceCitationV8(value: unknown): PersonAnswerEvidenceCitationV8 {
  return evidenceCitation(value, 8);
}

function approvedRecordCitation(input: Record<string, unknown>): Extract<PersonAnswerCitationV3, { readonly kind: 'approved_record' }> {
  assertExactKeys(input, ['kind', 'atom_id', 'record_sha256', 'policy_id'], 'Ask citation');
  assertDigest(input.atom_id, 'Ask approved-record citation atom_id');
  assertDigest(input.record_sha256, 'Ask approved-record citation record_sha256');
  if (!['restricted-reviewer-person-v2', 'project-members-readable-person-v1'].includes(input.policy_id as string)) fail('Ask approved-record citation policy_id is invalid');
  return Object.freeze({ kind: 'approved_record', atom_id: input.atom_id as `sha256:${string}`, record_sha256: input.record_sha256 as `sha256:${string}`, policy_id: input.policy_id as ApprovedRecordPolicyV3 });
}

/**
 * The identity an Ask response checks for duplicate citations: a response cites each key once. Each kind's row keys it
 * by what it names (a project, a person and a tool by their ids, a tool container by its tool, scope, kind and container
 * id), never by its label or key. A renderer that numbers citations uses this key so it never builds a response this
 * refuses.
 */
export function personAnswerCitationKeyV8(value: PersonAnswerEvidenceCitationV8): string {
  // A value of no known kind keeps the passage key it always had.
  return (citationKind(value.kind) ?? CITATION_KINDS.source_revision as CitationKindRow<PersonAnswerEvidenceCitationV8>).key(value);
}

const EVIDENCE_KINDS_V1: readonly string[] = ['imported_meeting', 'decision', 'action', 'rationale', 'note', 'document_passage'];

/** A record's or a passage's evidence kind, or, from its version, a citation kind named by itself. */
function evidenceKind(value: unknown, label: string, version: CitationVersion = 4): asserts value is PersonEvidenceKindV5 {
  const kind = citationKind(value);
  if (kind?.named !== undefined && kind.since <= version) return;
  if (!EVIDENCE_KINDS_V1.includes(value as string)) fail(`${label} is invalid`);
}

function visibility(value: unknown, label: string): asserts value is PersonEvidenceVisibilityV1 {
  if (!['only_me', 'team', 'project', 'projects', 'approver_only'].includes(value as string)) fail(`${label} is invalid`);
}

function statement(value: unknown, citations: readonly PersonAnswerCitationV8[], label: string, fallback = false): PersonAnswerStatementV4 {
  const input = object(value, label);
  assertExactKeys(input, ['text', 'citation_indexes', 'private'], label);
  if (fallback) evidenceText(input.text, `${label} text`, PERSON_EVIDENCE_TEXT_MAX_BYTES_V1);
  else text(input.text, `${label} text`, PERSON_ANSWER_STATEMENT_MAX_BYTES_V4, true);
  if (!Array.isArray(input.citation_indexes) || input.citation_indexes.length === 0 || input.citation_indexes.length > PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4 || typeof input.private !== 'boolean') fail(`${label} is invalid`);
  const indexes = citationIndexes(input.citation_indexes, `${label} citation_indexes`, citations.length, PERSON_ANSWER_STATEMENT_MAX_CITATIONS_V4);
  const expectedPrivate = indexes.some((index) => ['only_me', 'approver_only'].includes(citations[index]!.visibility));
  if (input.private !== expectedPrivate) fail(`${label} private is inconsistent with cited visibility`);
  return Object.freeze({ text: input.text as string, citation_indexes: indexes, private: input.private });
}

function answerCitation(value: unknown, version: 6 | 8): PersonAnswerCitationV8 {
  const input = object(value, 'Ask response citation');
  assertExactKeys(input, ['citation', 'kind', 'label', 'visibility', ...(Object.hasOwn(input, 'ref') ? ['ref'] : []), ...(version === 8 && Object.hasOwn(input, 'key') ? ['key'] : [])], 'Ask response citation');
  evidenceKind(input.kind, 'Ask response citation kind', version);
  text(input.label, 'Ask response citation label', PERSON_EVIDENCE_LABEL_MAX_BYTES_V1);
  visibility(input.visibility, 'Ask response citation visibility');
  const cited = evidenceCitation(input.citation, version);
  for (const [name, row] of Object.entries(CITATION_KINDS)) {
    if (row.named !== undefined && (cited.kind === name) !== (input.kind === name)) fail(`${row.named} citation kind is inconsistent`);
  }
  const ref: PersonAnswerOpenRefV8 | undefined = !Object.hasOwn(input, 'ref') ? undefined
    : version === 8 && typeof input.ref === 'string' && input.ref.startsWith('follow_up:') ? validatePersonFollowUpRefV1(input.ref, 'Ask response citation ref')
      : version === 8 && typeof input.ref === 'string' && (input.ref.startsWith('project:') || input.ref.startsWith('tool:')) ? validatePersonWorkspaceRefV1(input.ref, 'Ask response citation ref')
        : validatePersonItemRefV1(input.ref, 'Ask response citation ref');
  const row = citationKind(cited.kind)!;
  if (row.ref_required && ref === undefined) fail(`${row.named} citation ref is missing`);
  if (ref !== undefined && !(row.opens?.(cited, ref) ?? false)) fail('Ask response citation ref is inconsistent');
  if (Object.hasOwn(input, 'key')) {
    if (cited.kind !== 'tool_container') fail('Ask response citation key applies only to a tool container');
    text(input.key, 'Ask response citation key', 256);
  }
  return Object.freeze({
    citation: cited, kind: input.kind, label: input.label as string, visibility: input.visibility, ...(ref === undefined ? {} : { ref }),
    ...(Object.hasOwn(input, 'key') ? { key: input.key as string } : {}),
  });
}

function part(value: unknown, citations: readonly PersonAnswerCitationV8[]): PersonAnswerPartV4 {
  const input = object(value, 'Ask response part');
  assertExactKeys(input, ['question', 'status', 'statements', ...['gap', 'gap_details', 'records', 'blocks'].filter(key => Object.hasOwn(input, key))], 'Ask response part');
  text(input.question, 'Ask response part question', 1024);
  // A part's statements have no count of their own (ADR-0051): its blocks arrange them, and the answer's bytes bound them.
  if (!['answered', 'partial', 'not_found', 'records_only'].includes(input.status as string) || !Array.isArray(input.statements)) fail('Ask response part is invalid');
  if (Object.hasOwn(input, 'gap')) text(input.gap, 'Ask response part gap', 2 * 1024, true);
  if (Object.hasOwn(input, 'records') && (!Array.isArray(input.records) || input.records.length > 40)) fail('Ask response part records is invalid');
  const statements = Object.freeze(input.statements.map((item) => statement(item, citations, 'Ask response statement')));
  // Blocks arrange written statements (answer layout v2, ADR-0051): a part with statements has them, and one with none has nothing to arrange.
  if (Object.hasOwn(input, 'blocks') !== statements.length > 0) fail('Ask response part blocks are invalid');
  return Object.freeze({
    question: input.question as string,
    status: input.status as PersonAnswerPartV4['status'],
    statements,
    ...(Object.hasOwn(input, 'gap') ? { gap: input.gap as string } : {}),
    ...(Object.hasOwn(input, 'gap_details') ? { gap_details: validatePersonAnswerGapDetailsV1(input.gap_details) } : {}),
    ...(Object.hasOwn(input, 'records') ? { records: Object.freeze((input.records as unknown[]).map((item) => statement(item, citations, 'Ask response fallback record', true))) } : {}),
    ...(Object.hasOwn(input, 'blocks') ? { blocks: validatePersonAnswerBlocksV2(input.blocks, statements, citations.length) } : {}),
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
  return Object.freeze({ id: input.id as string, citation: cited, kind: input.kind, ...(Object.hasOwn(input, 'text') ? { text: input.text as string } : {}), label: input.label as string, visibility: input.visibility, ...(attributes === undefined ? {} : { attributes }), ...(Object.hasOwn(input, 'occurred_at') ? { occurred_at: input.occurred_at as string } : {}), receipt_sha256: input.receipt_sha256 as `sha256:${string}` });
}

function boundedRequest<T>(result: T, label: string): T {
  if (canonicalJsonBytes(result).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail(`${label} exceeds JSON byte bound`);
  return Object.freeze(result);
}

export function validatePersonAnswerRequestV3(value: unknown): PersonAnswerRequestV3 {
  const input = object(value, 'Ask request');
  assertExactKeys(input, ['schema_version', 'question', ...(Object.hasOwn(input, 'project_id') ? ['project_id'] : []), ...(Object.hasOwn(input, 'capture_id') ? ['capture_id'] : []), ...(Object.hasOwn(input, 'previous') ? ['previous'] : [])], 'Ask request');
  if (input.schema_version !== 3) fail('Ask request schema_version is unsupported');
  const request = boundedRequest({ schema_version: 3 as const, question: validatePersonQueryText(input.question), ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Ask request project_id') } : {}), ...(Object.hasOwn(input, 'capture_id') ? { capture_id: validatePersonDiagnosticCaptureIdV1(input.capture_id) } : {}), ...(Object.hasOwn(input, 'previous') ? { previous: previousTurn(input.previous) } : {}) }, 'Ask request');
  // Ask again asks the earlier question itself (ADR-0047), and its answer names that question: one of another is refused.
  if (request.previous?.purpose === 'ask_again' && request.previous.question !== request.question) fail('Ask previous question is not the question asked again');
  return request;
}

/** A question an Ask request or answer carries beside its own: it passes the question rules, refused here as this contract's own failure. */
function fullQuestion(value: unknown, label: string): string {
  try { return validatePersonQueryText(value); } catch { return fail(`${label} is invalid`); }
}

/** Distinct whole indexes below `bound`, at most `maximum` of them. */
function citationIndexes(value: unknown, label: string, bound: number, maximum: number): readonly number[] {
  const indexes = boundedList(value, label, maximum).map((index) => {
    if (!Number.isSafeInteger(index) || (index as number) < 0 || (index as number) >= bound) fail(`${label} is invalid`);
    return index as number;
  });
  if (new Set(indexes).size !== indexes.length) fail(`${label} contains duplicates`);
  return Object.freeze(indexes);
}

/**
 * The asker's previous turn (ADR-0047): its purpose, full question and time, 0 to 8 of its answer's sentences of at
 * most 400 characters, and 0 to 12 of its citations, each once, as that answer carried them, which each sentence cites
 * by index (at most 4). The whole request keeps its 16 KiB bound.
 */
function previousTurn(value: unknown): PersonAnswerPreviousV1 {
  const input = object(value, 'Ask previous');
  assertExactKeys(input, ['purpose', 'question', 'asked_at', 'statements', 'citations'], 'Ask previous');
  const purpose = oneOf(input.purpose, ['follow_up', 'ask_again'], 'Ask previous purpose');
  const question = fullQuestion(input.question, 'Ask previous question');
  assertTimestamp(input.asked_at, 'Ask previous asked_at');
  const citations = Object.freeze(boundedList(input.citations, 'Ask previous citations', PERSON_ANSWER_PREVIOUS_MAX_CITATIONS_V1).map(item => answerCitation(item, 8)));
  const keys = new Set(citations.map(item => personAnswerCitationKeyV8(item.citation)));
  if (keys.size !== citations.length) fail('Ask previous contains duplicate citations');
  const statements = Object.freeze(boundedList(input.statements, 'Ask previous statements', PERSON_ANSWER_PREVIOUS_MAX_STATEMENTS_V1).map((raw): PersonAnswerPreviousStatementV1 => {
    const item = object(raw, 'Ask previous statement');
    assertExactKeys(item, ['text', 'citation_indexes'], 'Ask previous statement');
    // An answer's sentence as it was released: trimmed NFC text, line breaks allowed.
    text(item.text, 'Ask previous statement text', 4 * PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1, true);
    if ([...item.text as string].length > PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CHARS_V1) fail('Ask previous statement text is invalid');
    return Object.freeze({
      text: item.text as string,
      citation_indexes: citationIndexes(item.citation_indexes, 'Ask previous statement citation_indexes', citations.length, PERSON_ANSWER_PREVIOUS_STATEMENT_MAX_CITATIONS_V1),
    });
  }));
  return Object.freeze({ purpose, question, asked_at: input.asked_at as string, statements, citations });
}

/** A clarify answer's choices (ADR-0047): 2 to 4, each a label of at most 60 characters and a full question, each different. */
function answerChoices(value: unknown): readonly PersonAnswerChoiceV1[] {
  const choices = Object.freeze(boundedList(value, 'Ask response choices', PERSON_ANSWER_CHOICES_MAX_V1, PERSON_ANSWER_CHOICES_MIN_V1).map((raw) => {
    const input = object(raw, 'Ask response choice');
    assertExactKeys(input, ['label', 'question'], 'Ask response choice');
    return Object.freeze({
      label: boundedLine(input.label, 'Ask response choice label', PERSON_ANSWER_CHOICE_LABEL_MAX_CHARS_V1),
      question: fullQuestion(input.question, 'Ask response choice question'),
    });
  }));
  if (new Set(choices.map(choice => choice.question)).size !== choices.length || new Set(choices.map(choice => choice.label)).size !== choices.length) fail('Ask response choices contains duplicates');
  return choices;
}

/** What is different since the earlier answer (ADR-0047): 0 to 6 statements, each citing the answer's citations. */
function answerSince(value: unknown, citations: readonly PersonAnswerCitationV8[]): PersonAnswerSinceV1 {
  const input = object(value, 'Ask response since');
  assertExactKeys(input, ['statements'], 'Ask response since');
  return Object.freeze({ statements: Object.freeze(boundedList(input.statements, 'Ask response since', PERSON_ANSWER_SINCE_MAX_STATEMENTS_V1).map(item => statement(item, citations, 'Ask response since statement'))) });
}

/** One V6 response citation, as the impact card (person-impact-card-v1.ts) cites items: never a follow-up or a workspace item. */
export function validatePersonAnswerCitationV6(value: unknown): PersonAnswerCitationV6 { return answerCitation(value, 6) as PersonAnswerCitationV6; }
/**
 * One V8 response citation (research tool contract v1): an approved record, a passage, a ticket, a page, a follow-up with
 * its follow-up ref (ADR-0040), a project or a tool with the ref that opens it, a person, or a tool container with its key
 * when it has one.
 */
export function validatePersonAnswerCitationV8(value: unknown): PersonAnswerCitationV8 { return answerCitation(value, 8); }
/** The Ask answer, `/v7`'s (research tool contract v1): the only one, since the V4 to V7 answers were retired with their routes. */
export function validatePersonAnswerResponseV8(value: unknown): PersonAnswerResponseV8 {
  const input = object(value, 'Ask response');
  // Only an answer to a request that carried the previous turn (ADR-0047) names its question, says what is different
  // since, or offers choices.
  const previous = ['question', 'since', 'choices'].filter(key => Object.hasOwn(input, key));
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'outcome', 'citations', 'parts', ...(Object.hasOwn(input, 'direct') ? ['direct'] : []), ...(Object.hasOwn(input, 'notice') ? ['notice'] : []), ...previous], 'Ask response');
  // A clarify outcome (ADR-0047) asks which one instead of answering: no part and no citation.
  const clarify = input.outcome === 'clarify';
  // An answer has no count of citations of its own (ADR-0051): its bytes bound it.
  if (input.schema_version !== 8 || input.kind !== 'echo-clean-person-answer-v8' || !(PERSON_ANSWER_OUTCOMES_V8 as readonly unknown[]).includes(input.outcome) || !Array.isArray(input.citations) || !Array.isArray(input.parts) || (clarify ? input.parts.length !== 0 : input.parts.length < 1 || input.parts.length > 5)) fail('Ask response is invalid');
  if (Object.hasOwn(input, 'notice')) text(input.notice, 'Ask response notice', 2 * 1024, true);
  const citations = input.citations.map(item => answerCitation(item, 8));
  const citationKeys = new Set<string>();
  for (const item of citations) { const key = personAnswerCitationKeyV8(item.citation); if (citationKeys.has(key)) fail('Ask response contains duplicate citations'); citationKeys.add(key); }
  const result = {
    schema_version: 8 as const, kind: 'echo-clean-person-answer-v8' as const, scope: scope(input.scope), outcome: input.outcome as PersonAnswerResponseV8['outcome'], citations: Object.freeze(citations),
    ...(Object.hasOwn(input, 'direct') ? { direct: statement(input.direct, citations, 'Ask response direct') } : {}),
    parts: Object.freeze(input.parts.map((item) => part(item, citations))),
    ...(Object.hasOwn(input, 'notice') ? { notice: input.notice as string } : {}),
    ...(previous.includes('question') ? { question: fullQuestion(input.question, 'Ask response question') } : {}),
    ...(previous.includes('since') ? { since: answerSince(input.since, citations) } : {}),
    ...(previous.includes('choices') ? { choices: answerChoices(input.choices) } : {}),
  };
  for (const item of result.parts) {
    if (item.status === 'answered' && (item.statements.length === 0 || item.gap !== undefined || item.gap_details !== undefined || item.records !== undefined)) fail('Answered part is inconsistent');
    if (item.status === 'partial' && (item.statements.length === 0 || item.records !== undefined)) fail('Partial part is inconsistent');
    if (item.status === 'not_found' && (item.statements.length !== 0 || item.records !== undefined)) fail('Not-found part is inconsistent');
    if (item.status === 'records_only' && (item.statements.length !== 0 || item.records === undefined || item.records.length === 0)) fail('Records-only part is inconsistent');
  }
  if (result.outcome === 'answered' && result.parts.some((item) => item.status === 'partial' || item.status === 'not_found')) fail('Answered outcome is inconsistent');
  if (result.outcome === 'partial' && !result.parts.some((item) => item.status === 'partial' || item.status === 'not_found' || item.status === 'records_only')) fail('Partial outcome is inconsistent');
  if (result.outcome === 'not_found' && (result.direct !== undefined || result.citations.length !== 0 || result.parts.some((item) => item.status !== 'not_found' || item.statements.length !== 0 || item.records !== undefined))) fail('No-evidence outcome is inconsistent');
  if (result.outcome === 'not_found' && result.parts.some(item => item.gap_details?.unsupported_action || item.gap_details?.interrupted)) fail('No-match outcome cannot be an unsupported action or interrupted research');
  // Choices come only with clarify, which answers a follow-up: it names the question asked, and says nothing else.
  if (clarify !== previous.includes('choices') || (clarify && (result.citations.length !== 0 || result.direct !== undefined || result.notice !== undefined || !previous.includes('question') || previous.includes('since')))) fail('Clarify outcome is inconsistent');
  // `since` answers an Ask again, which names its question; an answer that cites nothing cannot say what is different.
  if (previous.includes('since') && (!previous.includes('question') || result.citations.length === 0)) fail('Ask response since is inconsistent');
  if (canonicalJsonBytes(result).byteLength > PERSON_ANSWER_RESPONSE_MAX_BYTES_V4) fail('Ask response exceeds JSON byte bound');
  return Object.freeze(result) as PersonAnswerResponseV8;
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
  return boundedRequest({ schema_version: 1 as const, citation: evidenceCitation(input.citation) as PersonAnswerCitationV3, ...(Object.hasOwn(input, 'neighbours') ? { neighbours: input.neighbours as 0 | 1 | 2 } : {}), ...(Object.hasOwn(input, 'project_id') ? { project_id: validateProjectIdV1(input.project_id, 'Evidence open request project_id') } : {}) }, 'Evidence open request');
}

export function validatePersonEvidenceDeskResponseV1(value: unknown): PersonEvidenceDeskResponseV1 {
  const input = object(value, 'Evidence desk response');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'items', 'truncated', ...(Object.hasOwn(input, 'notice') ? ['notice'] : [])], 'Evidence desk response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-evidence-desk-v1' || !Array.isArray(input.items) || input.items.length > 50 || typeof input.truncated !== 'boolean') fail('Evidence desk response is invalid');
  if (Object.hasOwn(input, 'notice')) text(input.notice, 'Evidence desk response notice', 2 * 1024, true);
  const items = input.items.map(item => deskItem(item));
  const ids = new Set<string>(); const coordinates = new Set<string>();
  for (const item of items) { if (ids.has(item.id)) fail('Evidence desk response contains duplicate item IDs'); ids.add(item.id); const key = personAnswerCitationKeyV8(item.citation); if (coordinates.has(key)) fail('Evidence desk response contains duplicate citations'); coordinates.add(key); }
  const result = { schema_version: 1, kind: 'echo-person-evidence-desk-v1', scope: scope(input.scope), items: Object.freeze(items), truncated: input.truncated, ...(Object.hasOwn(input, 'notice') ? { notice: input.notice as string } : {}) };
  if (canonicalJsonBytes(result).byteLength > PERSON_EVIDENCE_RESPONSE_MAX_BYTES_V1) fail('Evidence desk response exceeds JSON byte bound');
  return Object.freeze(result) as PersonEvidenceDeskResponseV1;
}

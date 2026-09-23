import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonQueryText } from './person-query.js';
import { validatePersonDocumentIdV1 } from './person-documents-v1.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertOnlyEnumerableDataProperties,
  fail,
  MAX_ORGANIZATION_API_BODY_BYTES,
} from './validation.js';

/** Versioned Ask endpoint. The V1 route remains approved-record-only. */
export const PERSON_ANSWER_PATH_V2 = '/v2/person/ask';
export const PERSON_SOURCE_EVIDENCE_PATH_V1 = '/v2/person/ask/source';
export const PERSON_ANSWER_RESPONSE_MAX_BYTES_V3 = 64 * 1024;
export const PERSON_SOURCE_EVIDENCE_MAX_TEXT_BYTES_V1 = 3 * 1024;

export interface PersonAnswerRequestV2 {
  readonly schema_version: 2;
  readonly question: string;
  /** Omitted selects every context the caller may read. Present is a strict project scope. */
  readonly project_id?: ProjectIdV1;
}

export type PersonAnswerScopeV3 =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly project_id: ProjectIdV1 };

export type PersonAnswerCitationV3 =
  | {
      readonly kind: 'approved_record';
      readonly atom_id: `sha256:${string}`;
      readonly record_sha256: `sha256:${string}`;
      readonly policy_id:
        | 'organization-member-readable-person-v2'
        | 'restricted-reviewer-person-v2';
    }
  | {
      readonly kind: 'source_revision';
      readonly source_id: `source:${string}`;
      readonly revision_id: string;
      /** Immutable admitted source-revision digest; never infer an original artifact digest from it. */
      readonly source_sha256: `sha256:${string}`;
      /** Immutable extracted representation digest used for this evidence. */
      readonly representation_sha256: `sha256:${string}`;
      /** Immutable anchor digest inside that representation. */
      readonly anchor_sha256: `sha256:${string}`;
      readonly document_id?: `doc_${string}`;
      readonly label?: string;
    };

export interface PersonAnswerResponseV3 {
  readonly schema_version: 3;
  readonly kind: 'echo-clean-person-answer-v3';
  readonly answer: string;
  readonly citations: readonly PersonAnswerCitationV3[];
  readonly scope: PersonAnswerScopeV3;
  readonly outcome?: 'authorship_unsupported';
}

/** Immutable source coordinates deliberately exclude the display label. */
export interface PersonSourceEvidenceCitationV1 {
  readonly kind: 'source_revision';
  readonly source_id: `source:${string}`;
  readonly revision_id: string;
  readonly source_sha256: `sha256:${string}`;
  readonly representation_sha256: `sha256:${string}`;
  readonly anchor_sha256: `sha256:${string}`;
  readonly document_id?: `doc_${string}`;
}

export interface PersonSourceEvidenceReadRequestV1 {
  readonly schema_version: 1;
  readonly scope: PersonAnswerScopeV3;
  readonly citation: PersonSourceEvidenceCitationV1;
}

export interface PersonSourceEvidenceV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-source-evidence-v1';
  readonly scope: PersonAnswerScopeV3;
  /** The server derives this label from the immutable retained source. */
  readonly citation: PersonSourceEvidenceCitationV1 & { readonly label: string };
  /** Bounded canonical evidence packet, not the original file or a mutable latest version. */
  readonly text: string;
}

function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}

function boundedText(value: unknown, label: string, maximumCodePoints: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    value !== value.normalize('NFC') ||
    /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value) ||
    [...value].length > maximumCodePoints
  ) {
    fail(`${label} is invalid`);
  }
}

/** Answers may contain intentional paragraphs, lists, and tabs; citations may not. */
function answerText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
    [...value].length > 12_000
  ) {
    fail('Ask response answer is invalid');
  }
}

function sourceId(value: unknown): asserts value is `source:${string}` {
  if (typeof value !== 'string' || !/^source:[a-f0-9]{64}$/.test(value)) {
    fail('Ask source citation source_id is invalid');
  }
}

function sourceRevision(value: unknown): asserts value is string {
  boundedText(value, 'Ask source citation revision_id', 512);
}

function evidenceText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value !== value.normalize('NFC') ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) ||
    utf8Bytes(value) > PERSON_SOURCE_EVIDENCE_MAX_TEXT_BYTES_V1
  ) {
    fail('Ask source evidence text is invalid');
  }
}

function utf8Bytes(value: string): number {
  return [...value].reduce((total, character) => {
    const point = character.codePointAt(0)!;
    return total + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0);
}

function scope(value: unknown): PersonAnswerScopeV3 {
  const input = object(value, 'Ask response scope');
  if (input.kind === 'global') {
    assertExactKeys(input, ['kind'], 'Ask response scope');
    return Object.freeze({ kind: 'global' });
  }
  if (input.kind === 'project') {
    assertExactKeys(input, ['kind', 'project_id'], 'Ask response scope');
    return Object.freeze({
      kind: 'project',
      project_id: validateProjectIdV1(input.project_id, 'Ask response scope project_id'),
    });
  }
  fail('Ask response scope is invalid');
}

function citation(value: unknown): PersonAnswerCitationV3 {
  const input = object(value, 'Ask citation');
  if (input.kind === 'approved_record') {
    assertExactKeys(input, ['kind', 'atom_id', 'record_sha256', 'policy_id'], 'Ask citation');
    assertDigest(input.atom_id, 'Ask approved-record citation atom_id');
    assertDigest(input.record_sha256, 'Ask approved-record citation record_sha256');
    if (
      input.policy_id !== 'organization-member-readable-person-v2' &&
      input.policy_id !== 'restricted-reviewer-person-v2'
    ) {
      fail('Ask approved-record citation policy_id is invalid');
    }
    return Object.freeze({
      kind: 'approved_record',
      atom_id: input.atom_id as `sha256:${string}`,
      record_sha256: input.record_sha256 as `sha256:${string}`,
      policy_id: input.policy_id,
    });
  }
  if (input.kind === 'source_revision') {
    const keys = [
      'kind',
      'source_id',
      'revision_id',
      'source_sha256',
      'representation_sha256',
      'anchor_sha256',
    ];
    if (Object.hasOwn(input, 'document_id')) keys.push('document_id');
    if (Object.hasOwn(input, 'label')) keys.push('label');
    assertExactKeys(input, keys, 'Ask citation');
    sourceId(input.source_id);
    sourceRevision(input.revision_id);
    assertDigest(input.source_sha256, 'Ask source citation source_sha256');
    assertDigest(input.representation_sha256, 'Ask source citation representation_sha256');
    assertDigest(input.anchor_sha256, 'Ask source citation anchor_sha256');
    const document_id = Object.hasOwn(input, 'document_id')
      ? validatePersonDocumentIdV1(input.document_id)
      : undefined;
    if (Object.hasOwn(input, 'label')) boundedText(input.label, 'Ask source citation label', 200);
    return Object.freeze({
      kind: 'source_revision',
      source_id: input.source_id,
      revision_id: input.revision_id,
      source_sha256: input.source_sha256 as `sha256:${string}`,
      representation_sha256: input.representation_sha256 as `sha256:${string}`,
      anchor_sha256: input.anchor_sha256 as `sha256:${string}`,
      ...(document_id === undefined ? {} : { document_id }),
      ...(input.label === undefined ? {} : { label: input.label as string }),
    });
  }
  fail('Ask citation kind is invalid');
}

function sourceEvidenceCitation(value: unknown, labelRequired: boolean): PersonSourceEvidenceCitationV1 | (PersonSourceEvidenceCitationV1 & { readonly label: string }) {
  const input = object(value, 'Ask source evidence citation');
  assertExactKeys(
    input,
    [
      'kind',
      'source_id',
      'revision_id',
      'source_sha256',
      'representation_sha256',
      'anchor_sha256',
      ...(Object.hasOwn(input, 'document_id') ? ['document_id'] : []),
      ...(labelRequired ? ['label'] : []),
    ],
    'Ask source evidence citation',
  );
  if (input.kind !== 'source_revision') fail('Ask source evidence citation kind is invalid');
  sourceId(input.source_id);
  sourceRevision(input.revision_id);
  assertDigest(input.source_sha256, 'Ask source evidence citation source_sha256');
  assertDigest(input.representation_sha256, 'Ask source evidence citation representation_sha256');
  assertDigest(input.anchor_sha256, 'Ask source evidence citation anchor_sha256');
  const document_id = Object.hasOwn(input, 'document_id')
    ? validatePersonDocumentIdV1(input.document_id)
    : undefined;
  if (labelRequired) boundedText(input.label, 'Ask source evidence citation label', 200);
  return Object.freeze({
    kind: 'source_revision',
    source_id: input.source_id,
    revision_id: input.revision_id,
    source_sha256: input.source_sha256 as `sha256:${string}`,
    representation_sha256: input.representation_sha256 as `sha256:${string}`,
    anchor_sha256: input.anchor_sha256 as `sha256:${string}`,
    ...(document_id === undefined ? {} : { document_id }),
    ...(labelRequired ? { label: input.label as string } : {}),
  });
}

export function validatePersonAnswerRequestV2(value: unknown): PersonAnswerRequestV2 {
  const input = object(value, 'Ask request');
  assertExactKeys(
    input,
    ['schema_version', 'question', ...(Object.hasOwn(input, 'project_id') ? ['project_id'] : [])],
    'Ask request',
  );
  if (input.schema_version !== 2) fail('Ask request schema_version is unsupported');
  const result: PersonAnswerRequestV2 = {
    schema_version: 2,
    question: validatePersonQueryText(input.question),
    ...(Object.hasOwn(input, 'project_id')
      ? { project_id: validateProjectIdV1(input.project_id, 'Ask request project_id') }
      : {}),
  };
  if (canonicalJsonBytes(result).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) {
    fail('Ask request exceeds JSON byte bound');
  }
  return Object.freeze(result);
}

export function validatePersonAnswerResponseV3(value: unknown): PersonAnswerResponseV3 {
  const input = object(value, 'Ask response');
  assertExactKeys(
    input,
    ['schema_version', 'kind', 'answer', 'citations', 'scope', ...(Object.hasOwn(input, 'outcome') ? ['outcome'] : [])],
    'Ask response',
  );
  if (
    input.schema_version !== 3 ||
    input.kind !== 'echo-clean-person-answer-v3' ||
    !Array.isArray(input.citations) ||
    input.citations.length > 16 ||
    (Object.hasOwn(input, 'outcome') && input.outcome !== 'authorship_unsupported')
  ) {
    fail('Ask response is invalid');
  }
  answerText(input.answer);
  const citations = input.citations.map(citation);
  const citationKeys = new Set<string>();
  for (const item of citations) {
    const key = item.kind === 'approved_record'
      ? `approved_record:${item.atom_id}`
      : `source_revision:${item.source_id}:${item.revision_id}:${item.representation_sha256}:${item.anchor_sha256}`;
    if (citationKeys.has(key)) fail('Ask response contains duplicate citations');
    citationKeys.add(key);
  }
  if (input.outcome === 'authorship_unsupported' && citations.length !== 0) {
    fail('Ask authorship-unsupported response must not cite evidence');
  }
  const result: PersonAnswerResponseV3 = {
    schema_version: 3,
    kind: 'echo-clean-person-answer-v3',
    answer: input.answer,
    citations: Object.freeze(citations),
    scope: scope(input.scope),
    ...(Object.hasOwn(input, 'outcome') ? { outcome: 'authorship_unsupported' as const } : {}),
  };
  if (canonicalJsonBytes(result).byteLength > PERSON_ANSWER_RESPONSE_MAX_BYTES_V3) {
    fail('Ask response exceeds JSON byte bound');
  }
  return Object.freeze(result);
}

export function validatePersonSourceEvidenceReadRequestV1(value: unknown): PersonSourceEvidenceReadRequestV1 {
  const input = object(value, 'Ask source evidence request');
  assertExactKeys(input, ['schema_version', 'scope', 'citation'], 'Ask source evidence request');
  if (input.schema_version !== 1) fail('Ask source evidence request schema_version is unsupported');
  const result: PersonSourceEvidenceReadRequestV1 = {
    schema_version: 1,
    scope: scope(input.scope),
    citation: sourceEvidenceCitation(input.citation, false) as PersonSourceEvidenceCitationV1,
  };
  if (canonicalJsonBytes(result).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) {
    fail('Ask source evidence request exceeds JSON byte bound');
  }
  return Object.freeze(result);
}

export function validatePersonSourceEvidenceV1(value: unknown): PersonSourceEvidenceV1 {
  const input = object(value, 'Ask source evidence response');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'citation', 'text'], 'Ask source evidence response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-source-evidence-v1') {
    fail('Ask source evidence response is invalid');
  }
  const result: PersonSourceEvidenceV1 = {
    schema_version: 1,
    kind: 'echo-person-source-evidence-v1',
    scope: scope(input.scope),
    citation: sourceEvidenceCitation(input.citation, true) as PersonSourceEvidenceCitationV1 & { readonly label: string },
    text: input.text as string,
  };
  evidenceText(result.text);
  if (canonicalJsonBytes(result).byteLength > PERSON_SOURCE_EVIDENCE_MAX_TEXT_BYTES_V1 + 2048) {
    fail('Ask source evidence response exceeds JSON byte bound');
  }
  return Object.freeze(result);
}

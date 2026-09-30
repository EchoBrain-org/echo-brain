import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
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

/**
 * Shared Ask citation and scope shapes, and the cited-original read. The V2
 * Ask request and its V3 answer were retired with the one-shot Ask
 * (ADR-0022); agentic Ask answers are V4 (person-answer-v4.ts). The source
 * path keeps its V2 name because installed clients open citations there.
 */
export const PERSON_SOURCE_EVIDENCE_PATH_V1 = '/v2/person/ask/source';
export const PERSON_SOURCE_EVIDENCE_MAX_TEXT_BYTES_V1 = 3 * 1024;

export type PersonAnswerScopeV3 =
  | { readonly kind: 'global' }
  | { readonly kind: 'project'; readonly project_id: ProjectIdV1 }
  | { readonly kind: 'mine' };
/** A cited original or a transcript page is read under global or project scope. mine ⊆ global, so a mine answer's citations open under global. */
export type PersonSourceReadScopeV1 = Exclude<PersonAnswerScopeV3, { readonly kind: 'mine' }>;

export type PersonAnswerCitationV3 =
  | {
      readonly kind: 'approved_record';
      readonly atom_id: `sha256:${string}`;
      readonly record_sha256: `sha256:${string}`;
      readonly policy_id:
        | 'organization-member-readable-person-v2'
        | 'restricted-reviewer-person-v2'
        | 'project-members-readable-person-v1';
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
  readonly scope: PersonSourceReadScopeV1;
  readonly citation: PersonSourceEvidenceCitationV1;
}

export interface PersonSourceEvidenceV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-source-evidence-v1';
  readonly scope: PersonSourceReadScopeV1;
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

function scope(value: unknown): PersonSourceReadScopeV1 {
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

/**
 * An Ask, evidence-desk or list scope. Unlike a source read it may be mine:
 * the caller's own items, always a subset of global.
 */
export function validatePersonAnswerScopeV3(value: unknown, label = 'Ask response scope'): PersonAnswerScopeV3 {
  const input = object(value, label);
  if (input.kind === 'global' || input.kind === 'mine') {
    assertExactKeys(input, ['kind'], label);
    return Object.freeze(input.kind === 'global' ? { kind: 'global' } : { kind: 'mine' });
  }
  if (input.kind === 'project') {
    assertExactKeys(input, ['kind', 'project_id'], label);
    return Object.freeze({
      kind: 'project',
      project_id: validateProjectIdV1(input.project_id, `${label} project_id`),
    });
  }
  fail(`${label} is invalid`);
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

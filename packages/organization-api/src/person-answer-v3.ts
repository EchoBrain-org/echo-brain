import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { validatePersonDocumentIdV1 } from './person-documents-v1.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import {
  asEnumerableRecord as object,
  assertDigest,
  assertEvidenceText,
  assertExactKeys,
  boundedLine as line,
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

/** A cited original or a transcript page is read under global or project scope, never mine. */
export function validatePersonSourceReadScopeV1(value: unknown, label = 'Ask response scope'): PersonSourceReadScopeV1 {
  if (object(value, label).kind === 'mine') fail(`${label} is invalid`);
  return validatePersonAnswerScopeV3(value, label) as PersonSourceReadScopeV1;
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

/**
 * A source-revision citation. Its display label is optional on an Ask
 * citation, required on a source read's answer and absent from its request.
 */
export function validatePersonSourceRevisionCitationV1(
  value: unknown,
  label: 'optional' | 'required' | 'absent',
  context = 'Ask citation',
): Extract<PersonAnswerCitationV3, { readonly kind: 'source_revision' }> {
  const input = object(value, context);
  const labelled = label === 'required' || (label === 'optional' && Object.hasOwn(input, 'label'));
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
      ...(labelled ? ['label'] : []),
    ],
    context,
  );
  if (input.kind !== 'source_revision') fail(`${context} kind is invalid`);
  if (typeof input.source_id !== 'string' || !/^source:[a-f0-9]{64}$/.test(input.source_id)) {
    fail('Ask source citation source_id is invalid');
  }
  const revision_id = line(input.revision_id, 'Ask source citation revision_id', 512);
  assertDigest(input.source_sha256, 'Ask source citation source_sha256');
  assertDigest(input.representation_sha256, 'Ask source citation representation_sha256');
  assertDigest(input.anchor_sha256, 'Ask source citation anchor_sha256');
  const document_id = Object.hasOwn(input, 'document_id')
    ? validatePersonDocumentIdV1(input.document_id)
    : undefined;
  return Object.freeze({
    kind: 'source_revision',
    source_id: input.source_id as `source:${string}`,
    revision_id,
    source_sha256: input.source_sha256 as `sha256:${string}`,
    representation_sha256: input.representation_sha256 as `sha256:${string}`,
    anchor_sha256: input.anchor_sha256 as `sha256:${string}`,
    ...(document_id === undefined ? {} : { document_id }),
    ...(labelled ? { label: line(input.label, 'Ask source citation label', 200) } : {}),
  });
}

export function validatePersonSourceEvidenceReadRequestV1(value: unknown): PersonSourceEvidenceReadRequestV1 {
  const input = object(value, 'Ask source evidence request');
  assertExactKeys(input, ['schema_version', 'scope', 'citation'], 'Ask source evidence request');
  if (input.schema_version !== 1) fail('Ask source evidence request schema_version is unsupported');
  const result: PersonSourceEvidenceReadRequestV1 = {
    schema_version: 1,
    scope: validatePersonSourceReadScopeV1(input.scope),
    citation: validatePersonSourceRevisionCitationV1(input.citation, 'absent', 'Ask source evidence citation') as PersonSourceEvidenceCitationV1,
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
    scope: validatePersonSourceReadScopeV1(input.scope),
    citation: validatePersonSourceRevisionCitationV1(input.citation, 'required', 'Ask source evidence citation') as PersonSourceEvidenceCitationV1 & { readonly label: string },
    text: input.text as string,
  };
  assertEvidenceText(result.text, 'Ask source evidence text', PERSON_SOURCE_EVIDENCE_MAX_TEXT_BYTES_V1);
  if (canonicalJsonBytes(result).byteLength > PERSON_SOURCE_EVIDENCE_MAX_TEXT_BYTES_V1 + 2048) {
    fail('Ask source evidence response exceeds JSON byte bound');
  }
  return Object.freeze(result);
}

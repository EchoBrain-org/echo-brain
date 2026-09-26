import { canonicalJsonBytes } from '@echo-brain/federation-protocol';
import { type PersonAnswerScopeV3 } from './person-answer-v3.js';
import { validateProjectIdV1, type ProjectIdV1 } from './project-context-v1.js';
import {
  asRecord,
  assertDigest,
  assertExactKeys,
  assertOnlyEnumerableDataProperties,
  fail,
  MAX_ORGANIZATION_API_BODY_BYTES,
} from './validation.js';

/** An explicit, approval-gated read. It is intentionally outside Ask retrieval. */
export const PERSON_MEETING_TRANSCRIPT_PATH_V1 = '/v1/person/meeting-transcripts/read';
export const PERSON_MEETING_TRANSCRIPT_MAX_TEXT_BYTES_V1 = 3 * 1024;

export interface PersonMeetingTranscriptCitationV1 {
  readonly kind: 'approved_meeting_transcript';
  readonly approval_id: string;
  readonly source_id: `source:${string}`;
  readonly revision_id: string;
  /** Immutable source-revision digest, never a provider artifact digest. */
  readonly source_sha256: `sha256:${string}`;
}

export interface PersonMeetingTranscriptReadRequestV1 {
  readonly schema_version: 1;
  readonly scope: PersonAnswerScopeV3;
  readonly citation: PersonMeetingTranscriptCitationV1;
  /** Unicode-code-point offset in the canonical transcript text; default zero. */
  readonly offset?: number;
}

export interface PersonMeetingTranscriptV1 {
  readonly schema_version: 1;
  readonly kind: 'echo-person-meeting-transcript-v1';
  readonly scope: PersonAnswerScopeV3;
  readonly citation: PersonMeetingTranscriptCitationV1;
  readonly text: string;
  readonly next_offset: number | null;
}

function object(value: unknown, label: string): Record<string, unknown> {
  assertOnlyEnumerableDataProperties(value, label);
  return asRecord(value, label);
}

function text(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value !== value.normalize('NFC') ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value) || utf8Bytes(value) > maximum) {
    fail(`${label} is invalid`);
  }
}

function utf8Bytes(value: string): number {
  return [...value].reduce((total, character) => {
    const point = character.codePointAt(0)!;
    return total + (point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4);
  }, 0);
}

function scope(value: unknown): PersonAnswerScopeV3 {
  const input = object(value, 'Meeting transcript scope');
  if (input.kind === 'global') {
    assertExactKeys(input, ['kind'], 'Meeting transcript scope');
    return Object.freeze({ kind: 'global' });
  }
  if (input.kind === 'project') {
    assertExactKeys(input, ['kind', 'project_id'], 'Meeting transcript scope');
    return Object.freeze({ kind: 'project', project_id: validateProjectIdV1(input.project_id, 'Meeting transcript scope project_id') });
  }
  fail('Meeting transcript scope is invalid');
}

function citation(value: unknown): PersonMeetingTranscriptCitationV1 {
  const input = object(value, 'Meeting transcript citation');
  assertExactKeys(input, ['kind', 'approval_id', 'source_id', 'revision_id', 'source_sha256'], 'Meeting transcript citation');
  if (input.kind !== 'approved_meeting_transcript' || typeof input.approval_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(input.approval_id)) fail('Meeting transcript citation is invalid');
  if (typeof input.source_id !== 'string' || !/^source:[a-f0-9]{64}$/.test(input.source_id)) fail('Meeting transcript source_id is invalid');
  text(input.revision_id, 'Meeting transcript revision_id', 512);
  assertDigest(input.source_sha256, 'Meeting transcript source_sha256');
  return Object.freeze({ kind: 'approved_meeting_transcript', approval_id: input.approval_id, source_id: input.source_id as `source:${string}`, revision_id: input.revision_id, source_sha256: input.source_sha256 as `sha256:${string}` });
}

function offset(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 10_000_000) fail(`${label} is invalid`);
  return value;
}

export function validatePersonMeetingTranscriptReadRequestV1(value: unknown): PersonMeetingTranscriptReadRequestV1 {
  const input = object(value, 'Meeting transcript read request');
  assertExactKeys(input, ['schema_version', 'scope', 'citation', ...(Object.hasOwn(input, 'offset') ? ['offset'] : [])], 'Meeting transcript read request');
  if (input.schema_version !== 1) fail('Meeting transcript read request schema_version is unsupported');
  const result = Object.freeze({ schema_version: 1 as const, scope: scope(input.scope), citation: citation(input.citation), ...(Object.hasOwn(input, 'offset') ? { offset: offset(input.offset, 'Meeting transcript offset') } : {}) });
  if (canonicalJsonBytes(result).byteLength > MAX_ORGANIZATION_API_BODY_BYTES) fail('Meeting transcript read request exceeds JSON byte bound');
  return result;
}

export function validatePersonMeetingTranscriptV1(value: unknown): PersonMeetingTranscriptV1 {
  const input = object(value, 'Meeting transcript response');
  assertExactKeys(input, ['schema_version', 'kind', 'scope', 'citation', 'text', 'next_offset'], 'Meeting transcript response');
  if (input.schema_version !== 1 || input.kind !== 'echo-person-meeting-transcript-v1') fail('Meeting transcript response is invalid');
  const result = Object.freeze({ schema_version: 1 as const, kind: 'echo-person-meeting-transcript-v1' as const, scope: scope(input.scope), citation: citation(input.citation), text: input.text as string, next_offset: input.next_offset === null ? null : offset(input.next_offset, 'Meeting transcript next_offset') });
  text(result.text, 'Meeting transcript text', PERSON_MEETING_TRANSCRIPT_MAX_TEXT_BYTES_V1);
  if (result.next_offset !== null && result.next_offset <= 0) fail('Meeting transcript next_offset is invalid');
  if (canonicalJsonBytes(result).byteLength > PERSON_MEETING_TRANSCRIPT_MAX_TEXT_BYTES_V1 + 2048) fail('Meeting transcript response exceeds JSON byte bound');
  return result;
}

export type PersonMeetingTranscriptProjectScopeV1 = { readonly kind: 'project'; readonly project_id: ProjectIdV1 };

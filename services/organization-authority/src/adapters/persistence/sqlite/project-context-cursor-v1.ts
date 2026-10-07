import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';
import { isCanonicalUtcMillisTimestampV1 } from '../../../application/canonical-utc-timestamp-v1.js';

export interface ProjectCursorScopeV1 {
  readonly operation: 'project_list' | 'project_list_v2' | 'members' | 'directory' | 'organization_directory' | 'feed' | 'search' | 'feed_v2' | 'search_v2';
  readonly project_id?: string;
  readonly status?: 'active' | 'archived';
  readonly canonical_query?: string;
  readonly limit: number;
  readonly organization_id: string;
  readonly membership_id: string;
}
export type ProjectCursorPositionV1 = readonly [string, string] | readonly [number, string, string];

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const projectId = new RegExp(`^prj_${UUID}$`);
const membershipId = new RegExp(`^mem_${UUID}$`);
const contextId = /^ctx_[0-9a-f]{64}$/;
function invalid(): never { throw new AuthorityOperationError('invalid_request', 'request failed'); }
function displayName(value: string): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}
function position(fields: readonly string[], scope: ProjectCursorScopeV1): ProjectCursorPositionV1 {
  if (scope.operation === 'search' || scope.operation === 'search_v2') {
    if (fields.length !== 3 || !/^(0|[1-9][0-9]*)$/.test(fields[0]!) ||
        !Number.isSafeInteger(Number(fields[0])) || !isCanonicalUtcMillisTimestampV1(fields[1]!) || !contextId.test(fields[2]!)) invalid();
    return [Number(fields[0]), fields[1]!, fields[2]!];
  }
  if (fields.length !== 2) invalid();
  const [first, second] = fields as [string, string];
  if (scope.operation === 'members' || scope.operation === 'directory' || scope.operation === 'organization_directory') {
    if (!displayName(first) || !membershipId.test(second)) invalid();
  } else if (!isCanonicalUtcMillisTimestampV1(first) || !(scope.operation === 'project_list' || scope.operation === 'project_list_v2' ? projectId : contextId).test(second)) invalid();
  return [first, second];
}
function binding(scope: ProjectCursorScopeV1): Buffer {
  return Buffer.from(canonicalSha256({
    schema_version: 1,
    kind: 'echo-project-cursor-scope-v1',
    operation: scope.operation,
    project_id: scope.project_id ?? null,
    ...(scope.operation === 'project_list_v2' ? { status: scope.status ?? 'active' } : {}),
    canonical_query: scope.canonical_query ?? null,
    limit: scope.limit,
    organization_id: scope.organization_id,
    membership_id: scope.membership_id,
  }).slice(7), 'hex');
}

/**
 * Untrusted keyset only. No secret, authorization version or stored cursor.
 * The compact framing keeps even a 200-byte quoted display name below the
 * API's 512-character cursor bound: version, scope digest, NUL-separated UTF-8
 * public ordering coordinates. The scope hash is deliberately not a MAC.
 */
export function encodeProjectCursorV1(scope: ProjectCursorScopeV1, value: ProjectCursorPositionV1): string {
  const fields = value.map(String);
  position(fields, scope);
  return frameCursorV1(1, binding(scope), fields);
}

export function decodeProjectCursorV1(cursor: string | undefined, scope: ProjectCursorScopeV1): ProjectCursorPositionV1 | undefined {
  if (cursor === undefined) return undefined;
  return position(unframeCursorV1(cursor, 1, binding(scope)), scope);
}

/**
 * The shared framing: a version byte, a 32-byte binding digest and the
 * NUL-joined UTF-8 fields, base64url, at most 512 characters. Each cursor
 * family owns its version byte and validates its own fields.
 */
export function frameCursorV1(version: number, binding: Buffer, fields: readonly string[]): string {
  const encoded = Buffer.concat([Buffer.from([version]), binding, Buffer.from(fields.join('\0'), 'utf8')]).toString('base64url');
  if (encoded.length > 512) invalid();
  return encoded;
}

export function unframeCursorV1(cursor: string, version: number, binding: Buffer): readonly string[] {
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) invalid();
  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.length < 34 || decoded[0] !== version || decoded.toString('base64url') !== cursor ||
      !decoded.subarray(1, 33).equals(binding)) invalid();
  const encodedPosition = decoded.subarray(33);
  const text = encodedPosition.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(encodedPosition)) invalid();
  return text.split('\0');
}

export function normalizeProjectSearchQueryV1(query: string): string { return query.normalize('NFC').toLowerCase(); }
export function projectSearchTermsV1(query: string): readonly string[] {
  return [...new Set(normalizeProjectSearchQueryV1(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
}

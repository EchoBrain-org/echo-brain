import { canonicalSha256 } from '@echo-brain/federation-protocol';
import { AuthorityOperationError } from '@echo-brain/organization-authority-kernel/domain/errors';

export interface ProjectCursorScopeV1 {
  readonly operation: 'project_list' | 'members' | 'directory' | 'feed' | 'search';
  readonly project_id?: string;
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
function timestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
function displayName(value: string): boolean {
  return value.trim().length > 0 && Buffer.byteLength(value, 'utf8') <= 200 &&
    !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}
function position(fields: readonly string[], scope: ProjectCursorScopeV1): ProjectCursorPositionV1 {
  if (scope.operation === 'search') {
    if (fields.length !== 3 || !/^(0|[1-9][0-9]*)$/.test(fields[0]!) ||
        !Number.isSafeInteger(Number(fields[0])) || !timestamp(fields[1]!) || !contextId.test(fields[2]!)) invalid();
    return [Number(fields[0]), fields[1]!, fields[2]!];
  }
  if (fields.length !== 2) invalid();
  const [first, second] = fields as [string, string];
  if (scope.operation === 'members' || scope.operation === 'directory') {
    if (!displayName(first) || !membershipId.test(second)) invalid();
  } else if (!timestamp(first) || !(scope.operation === 'project_list' ? projectId : contextId).test(second)) invalid();
  return [first, second];
}
function binding(scope: ProjectCursorScopeV1): Buffer {
  return Buffer.from(canonicalSha256({
    schema_version: 1,
    kind: 'echo-project-cursor-scope-v1',
    operation: scope.operation,
    project_id: scope.project_id ?? null,
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
  const encoded = Buffer.concat([Buffer.from([1]), binding(scope), Buffer.from(fields.join('\0'), 'utf8')]).toString('base64url');
  if (encoded.length > 512) invalid();
  return encoded;
}

export function decodeProjectCursorV1(cursor: string | undefined, scope: ProjectCursorScopeV1): ProjectCursorPositionV1 | undefined {
  if (cursor === undefined) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 512) invalid();
  const decoded = Buffer.from(cursor, 'base64url');
  if (decoded.length < 34 || decoded[0] !== 1 || decoded.toString('base64url') !== cursor ||
      !decoded.subarray(1, 33).equals(binding(scope))) invalid();
  const encodedPosition = decoded.subarray(33);
  const text = encodedPosition.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(encodedPosition)) invalid();
  return position(text.split('\0'), scope);
}

export function normalizeProjectSearchQueryV1(query: string): string { return query.normalize('NFC').toLowerCase(); }
export function projectSearchTermsV1(query: string): readonly string[] {
  return [...new Set(normalizeProjectSearchQueryV1(query).match(/[\p{L}\p{N}]+/gu) ?? [])];
}

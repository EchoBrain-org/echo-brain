import {
  assertFederationId,
  canonicalJson,
} from '@echo-brain/federation-protocol';

export const AUTHORITY_RUNTIME_STATUS_PATH = '/_echo/runtime-status';
export const AUTHORITY_RUNTIME_STATUS_NONCE_HEADER =
  'x-echo-runtime-status-nonce';

export interface AuthorityRuntimeStatusV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-runtime-status';
  authority_id: string;
  organization_id: string;
  nonce: string;
  proof: `hmac-sha256:${string}`;
}

interface AuthorityRuntimeStatusProofMaterialV1 {
  schema_version: 1;
  kind: 'echo-organization-authority-runtime-status-proof';
  authority_id: string;
  organization_id: string;
  runtime_fingerprint_sha256: `sha256:${string}`;
  nonce: string;
}

export function assertAuthorityRuntimeStatusNonce(nonce: string): void {
  if (!/^[0-9a-f]{64}$/.test(nonce)) {
    throw new Error(
      'authority runtime status nonce must be 32 canonical bytes',
    );
  }
}

export function authorityRuntimeStatusProofMaterial(input: {
  authority_id: string;
  organization_id: string;
  runtime_fingerprint_sha256: `sha256:${string}`;
  nonce: string;
}): string {
  assertFederationId(input.authority_id, 'oau', 'runtime authority_id');
  assertFederationId(input.organization_id, 'org', 'runtime organization_id');
  assertAuthorityRuntimeStatusNonce(input.nonce);
  if (!/^sha256:[0-9a-f]{64}$/.test(input.runtime_fingerprint_sha256)) {
    throw new Error('authority runtime fingerprint must be a SHA-256 digest');
  }
  const material: AuthorityRuntimeStatusProofMaterialV1 = {
    schema_version: 1,
    kind: 'echo-organization-authority-runtime-status-proof',
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    runtime_fingerprint_sha256: input.runtime_fingerprint_sha256,
    nonce: input.nonce,
  };
  return canonicalJson(material);
}

export function validateAuthorityRuntimeStatus(
  value: unknown,
): AuthorityRuntimeStatusV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('authority runtime status response must be an object');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(',') !==
      'authority_id,kind,nonce,organization_id,proof,schema_version' ||
    record.schema_version !== 1 ||
    record.kind !== 'echo-organization-authority-runtime-status' ||
    typeof record.authority_id !== 'string' ||
    typeof record.organization_id !== 'string' ||
    typeof record.nonce !== 'string' ||
    typeof record.proof !== 'string' ||
    !/^hmac-sha256:[0-9a-f]{64}$/.test(record.proof)
  ) {
    throw new Error('authority runtime status response has an invalid shape');
  }
  assertFederationId(record.authority_id, 'oau', 'runtime authority_id');
  assertFederationId(record.organization_id, 'org', 'runtime organization_id');
  assertAuthorityRuntimeStatusNonce(record.nonce);
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-runtime-status',
    authority_id: record.authority_id,
    organization_id: record.organization_id,
    nonce: record.nonce,
    proof: record.proof as `hmac-sha256:${string}`,
  };
}

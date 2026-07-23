import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  authorityRuntimeStatusProofMaterial,
  type AuthorityRuntimeStatusV1,
} from '../../domain/runtime-status.js';

function challengeKey(secret: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(secret)) {
    throw new Error('authority runtime challenge secret is invalid');
  }
  return Buffer.from(secret, 'hex');
}

function proof(input: {
  secret: string;
  authority_id: string;
  organization_id: string;
  runtime_fingerprint_sha256: `sha256:${string}`;
  nonce: string;
}): `hmac-sha256:${string}` {
  const material = authorityRuntimeStatusProofMaterial(input);
  return `hmac-sha256:${createHmac('sha256', challengeKey(input.secret))
    .update(material)
    .digest('hex')}`;
}

export function createAuthorityRuntimeStatus(input: {
  secret: string;
  authority_id: string;
  organization_id: string;
  runtime_fingerprint_sha256: `sha256:${string}`;
  nonce: string;
}): AuthorityRuntimeStatusV1 {
  return {
    schema_version: 1,
    kind: 'echo-organization-authority-runtime-status',
    authority_id: input.authority_id,
    organization_id: input.organization_id,
    nonce: input.nonce,
    proof: proof(input),
  };
}

export function verifyAuthorityRuntimeStatus(
  status: AuthorityRuntimeStatusV1,
  secret: string,
  runtimeFingerprint: `sha256:${string}`,
): boolean {
  const expected = proof({
    secret,
    authority_id: status.authority_id,
    organization_id: status.organization_id,
    runtime_fingerprint_sha256: runtimeFingerprint,
    nonce: status.nonce,
  });
  return timingSafeEqual(Buffer.from(status.proof), Buffer.from(expected));
}

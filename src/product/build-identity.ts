import { readFileSync } from 'node:fs';

export interface PackagedBuildIdentityV1 {
  schema_version: 1;
  kind: 'echo-packaged-build-identity';
  product_version: string;
  source_sha: string;
  source_kind: 'materialized-commit' | 'worktree-head-unverified';
}

export function validatePackagedBuildIdentity(
  value: unknown,
): PackagedBuildIdentityV1 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('packaged build identity must be an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !==
      'kind,product_version,schema_version,source_kind,source_sha' ||
    record['schema_version'] !== 1 ||
    record['kind'] !== 'echo-packaged-build-identity' ||
    typeof record['product_version'] !== 'string' ||
    record['product_version'].length === 0 ||
    typeof record['source_sha'] !== 'string' ||
    !/^[a-f0-9]{40}$/.test(record['source_sha']) ||
    (record['source_kind'] !== 'materialized-commit' &&
      record['source_kind'] !== 'worktree-head-unverified')
  ) {
    throw new Error('packaged build identity has an unsupported shape');
  }
  return record as unknown as PackagedBuildIdentityV1;
}

export function loadPackagedBuildIdentity(): PackagedBuildIdentityV1 {
  const raw = readFileSync(new URL('./build-identity.v1.json', import.meta.url), 'utf8');
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`packaged build identity is invalid JSON: ${(error as Error).message}`);
  }
  return validatePackagedBuildIdentity(value);
}

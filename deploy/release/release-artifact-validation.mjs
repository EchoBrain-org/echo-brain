import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const clientIdentityPath = 'package/dist/build-identity.v1.json';
const clientIdentityKeys = ['kind', 'product_version', 'schema_version', 'source_kind', 'source_sha'];

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Validate the exact release record and Person-client archive supplied to a
 * release artifact builder. Command execution and error presentation stay in
 * the calling workflow so importing this module has no operational effects.
 */
export function readValidatedPersonClientReleaseArtifact({
  artifactPath,
  releasePath,
  releaseValidator,
  nodeExecutable,
  run,
  fail,
  artifactIdentityReadDescription = 'client artifact identity cannot be read',
}) {
  const canonical = run(
    nodeExecutable,
    [releaseValidator, 'validate', releasePath],
    'release record is invalid',
  );
  let release;
  try {
    release = JSON.parse(canonical);
  } catch {
    fail('release validator returned invalid JSON');
  }

  if (sha256File(artifactPath) !== release.person_client.artifact_sha256) {
    fail('client artifact SHA-256 does not match the release record');
  }
  const entries = run('tar', ['-tzf', artifactPath], 'client artifact cannot be read')
    .split('\n')
    .filter(Boolean);
  if (!entries.includes(clientIdentityPath)) {
    fail('client artifact lacks its packaged build identity');
  }
  const identityBytes = run(
    'tar',
    ['-xOzf', artifactPath, clientIdentityPath],
    artifactIdentityReadDescription,
  );
  let identity;
  try {
    identity = JSON.parse(identityBytes);
  } catch {
    fail('client artifact build identity is invalid JSON');
  }
  if (
    identity === null ||
    typeof identity !== 'object' ||
    Array.isArray(identity) ||
    JSON.stringify(Object.keys(identity).sort()) !== JSON.stringify(clientIdentityKeys) ||
    identity.schema_version !== 1 ||
    identity.kind !== 'echo-packaged-build-identity' ||
    identity.product_version !== release.person_client.version ||
    identity.source_kind !== 'materialized-commit' ||
    identity.source_sha !== release.source_sha
  ) {
    fail('client artifact build identity does not match the release record');
  }
  return release;
}

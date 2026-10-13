// Release packaging (ADR-0035) rebuilds the Person client from HEAD; that
// build's identity must name the release's clean commit and version.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

// Importing the script runs nothing: it packages only when started as a script.
const packager = pathToFileURL(resolve(import.meta.dirname, '../../scripts/package.mjs')).href;
const { requireReleaseClientBuild } = await import(packager) as { requireReleaseClientBuild: (identity: unknown, record: unknown) => void };

const record = { release_id: 'clean-v1-20261013-001', source_sha: 'a'.repeat(40), person_client: { version: '0.1.0-internal.6' } };
const built = { schema_version: 1, kind: 'echo-packaged-build-identity', product_version: '0.1.0-internal.6', source_sha: 'a'.repeat(40), source_kind: 'materialized-commit' };

it('accepts a clean build of the release commit at the release version', () => {
  expect(() => requireReleaseClientBuild(built, record)).not.toThrow();
});

it.each([
  ['of a modified checkout', { ...built, source_kind: 'worktree-head-unverified' }],
  ['of another commit', { ...built, source_sha: 'b'.repeat(40) }],
  ['of another version', { ...built, product_version: '0.1.0-internal.5' }],
  ['with another kind of identity', { ...built, kind: 'echo-desktop-identity-v1' }],
  ['without an identity', null],
])('refuses a build %s', (_, identity) => {
  expect(() => requireReleaseClientBuild(identity, record)).toThrow("not this release's clean commit and version");
});

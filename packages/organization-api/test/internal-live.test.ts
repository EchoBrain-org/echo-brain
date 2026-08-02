import { Buffer } from 'node:buffer';
import {
  generateKeyPairSync,
  randomUUID,
  sign as signMessage,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  normalizeP256LowS,
  p256KeyId,
} from '@echo-brain/federation-protocol';
import type { P256SigningKeyDescriptor } from '@echo-brain/federation-protocol';
import {
  compareOrganizationInternalLiveReleaseVersions,
  createOrganizationInternalLiveDirectiveRequest,
  createOrganizationInternalLiveUpdateReceipt,
  organizationInternalLiveManifestSha256,
  validateApproveOrganizationInternalLiveReleaseRequest,
  validateOrganizationInternalLiveReleaseManifest,
  validateOrganizationInternalLiveUpdateReceipt,
} from '../src/index.js';

function installationKey() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  const descriptor: P256SigningKeyDescriptor = {
    key_id: p256KeyId(publicBytes),
    algorithm: 'ecdsa-p256-sha256-der-low-s',
    public_key_spki_der_base64: publicBytes.toString('base64'),
  };
  return {
    descriptor,
    sign: async (bytes: Buffer) =>
      normalizeP256LowS(
        signMessage('sha256', bytes, {
          key: pair.privateKey,
          dsaEncoding: 'der',
        }),
      ),
  };
}

function manifest() {
  return {
    schema_version: 1 as const,
    kind: 'echo-internal-live-release' as const,
    channel: 'internal-live' as const,
    release_version: '0.1.0-internal.1',
    release_tag: 'internal-v0.1.0-internal.1',
    source: {
      sha: 'a'.repeat(40),
      kind: 'materialized-commit' as const,
    },
    artifact: {
      package: 'echo-brain' as const,
      filename: 'echo-brain-0.1.0-internal.1.tgz',
      download_url:
        'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.1/echo-brain-0.1.0-internal.1.tgz',
      size_bytes: 1234,
      sha256: 'b'.repeat(64),
    },
    compatibility: {
      os: 'darwin' as const,
      arch: 'arm64' as const,
      node: '22.22.1',
      npm: '10.9.4',
    },
    build: {
      repository: 'EchoBrain-org/echo-brain',
      workflow: 'internal-live-release.yml' as const,
      run_id: '123456789',
      run_attempt: 1,
    },
  };
}

function coordinates(key: P256SigningKeyDescriptor) {
  return {
    authority_id: `oau_${randomUUID()}`,
    authority_key_id: `sha256:${'c'.repeat(64)}` as const,
    organization_id: `org_${randomUUID()}`,
    enrollment_id: `enr_${randomUUID()}`,
    installation_id: `ins_${randomUUID()}`,
    installation_signing_key: key,
  };
}

describe('internal-live organization API', () => {
  it('pins the exact build-once manifest and its deterministic GitHub URLs', () => {
    const value = manifest();
    expect(validateOrganizationInternalLiveReleaseManifest(value)).toEqual(
      value,
    );
    const digest = organizationInternalLiveManifestSha256(value);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(
      validateApproveOrganizationInternalLiveReleaseRequest({
        schema_version: 1,
        kind: 'echo-internal-live-release-approval-request',
        command_id: `adm_${randomUUID()}`,
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.1/internal-live-release-manifest.v1.json',
        manifest_sha256: digest,
        manifest: value,
      }).manifest,
    ).toEqual(value);
  });

  it('accepts only the narrow numeric INTERNAL LIVE version and compares it as a tuple', () => {
    expect(compareOrganizationInternalLiveReleaseVersions(
      '0.1.0-internal.2',
      '0.1.0-internal.1',
    )).toBe(1);
    expect(compareOrganizationInternalLiveReleaseVersions(
      '0.1.0-internal.1',
      '0.1.0-internal.1',
    )).toBe(0);
    expect(compareOrganizationInternalLiveReleaseVersions(
      '0.1.0-internal.0',
      '0.1.0-internal.1',
    )).toBe(-1);
    for (const releaseVersion of [
      '0.1.0-dev.1',
      '0.1.0-internal.1+build.2',
      '0.1.0-internal.alpha',
      '01.0.0-internal.1',
    ]) {
      expect(() =>
        validateOrganizationInternalLiveReleaseManifest({
          ...manifest(),
          release_version: releaseVersion,
          release_tag: `internal-v${releaseVersion}`,
        }),
      ).toThrow(/release_version is invalid/);
    }
  });

  it('rejects divergent digests and extra remote-control fields', () => {
    expect(() =>
      validateApproveOrganizationInternalLiveReleaseRequest({
        schema_version: 1,
        kind: 'echo-internal-live-release-approval-request',
        command_id: `adm_${randomUUID()}`,
        manifest_url:
          'https://github.com/EchoBrain-org/echo-brain/releases/download/internal-v0.1.0-internal.1/internal-live-release-manifest.v1.json',
        manifest_sha256: 'd'.repeat(64),
        manifest: manifest(),
        command: 'curl | sh',
      }),
    ).toThrow(/unexpected shape/);
  });

  it('rejects a structurally valid manifest from any other repository', () => {
    const value = manifest();
    expect(() =>
      validateOrganizationInternalLiveReleaseManifest({
        ...value,
        artifact: {
          ...value.artifact,
          download_url:
            'https://github.com/attacker/echo-brain/releases/download/internal-v0.1.0-internal.1/echo-brain-0.1.0-internal.1.tgz',
        },
        build: {
          ...value.build,
          repository: 'attacker/echo-brain',
        },
      }),
    ).toThrow(/repository is unsupported/);
  });

  it('creates installation-signed directive requests and redacted receipts', async () => {
    const key = installationKey();
    const identity = coordinates(key.descriptor);
    const requestedAt = '2026-08-02T20:00:00.000Z';
    const request = await createOrganizationInternalLiveDirectiveRequest(
      {
        ...identity,
        request_id: `udr_${randomUUID()}`,
        requested_at: requestedAt,
      },
      key.sign,
    );
    expect(request.kind).toBe('echo-internal-live-directive-request');

    const receipt = await createOrganizationInternalLiveUpdateReceipt(
      {
        ...identity,
        transaction_id: `upd_${randomUUID()}`,
        directive_sequence: 1,
        release_version: manifest().release_version,
        manifest_sha256: organizationInternalLiveManifestSha256(manifest()),
        artifact_sha256: manifest().artifact.sha256,
        source_sha: manifest().source.sha,
        outcome: 'healthy',
        doctor: { ok: true, passed: 11, total: 11 },
        failure: null,
        finished_at: '2026-08-02T20:01:00.000Z',
      },
      key.sign,
    );
    expect(validateOrganizationInternalLiveUpdateReceipt(receipt)).toEqual(
      receipt,
    );
    expect(JSON.stringify(receipt)).not.toMatch(
      /path|command|config|credential|meeting|log/i,
    );
    expect(() =>
      validateOrganizationInternalLiveUpdateReceipt({
        ...receipt,
        log: '/Users/example/private.log',
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      validateOrganizationInternalLiveUpdateReceipt({
        ...receipt,
        previous: null,
      }),
    ).toThrow(/unexpected shape/);
    expect(() =>
      validateOrganizationInternalLiveUpdateReceipt({
        ...receipt,
        started_at: requestedAt,
      }),
    ).toThrow(/unexpected shape/);
  });
});

import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

const seams = vi.hoisted(() => ({
  inspectKey: vi.fn(),
  readSourceBinding: vi.fn(),
}));

vi.mock(
  '../src/adapters/persistence/sqlite/processing-source-runtime-binding.js',
  () => ({
    readAuthorityProcessingSourceRuntimeBinding: seams.readSourceBinding,
  }),
);

vi.mock(
  '../src/processing/authorization/security/existing-exportable-installation-key.js',
  () => ({
    ExistingExportableInstallationKey: class {
      readonly path = '/private/processing-key.json';
      inspect = seams.inspectKey;
    },
  }),
);

import { openAuthorityMeetingProcessingRuntime } from '../src/composition/meeting-processing-runtime.js';

const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const INSTALLATION_ID = 'ins_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const KEY_ID = `sha256:${'a'.repeat(64)}` as const;
const PUBLIC_KEY = 'installation-public-key';

function options(input: {
  readonly enrollmentKeyId?: `sha256:${string}`;
  readonly runtimeBinding: unknown;
}) {
  const runtimeBinding = vi.fn(() => input.runtimeBinding);
  const readSecret = vi.fn();
  const membership = vi.fn();
  const enrollmentByInstallation = vi.fn(() => ({
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    installation_id: INSTALLATION_ID,
    installation_signing_key: {
      key_id: input.enrollmentKeyId ?? KEY_ID,
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: PUBLIC_KEY,
    },
    status: 'active',
  }));
  const authorityRepository = {
    read(operation: (transaction: {
      enrollmentByInstallation: typeof enrollmentByInstallation;
      membership: typeof membership;
    }) => unknown) {
      return operation({ enrollmentByInstallation, membership });
    },
  };
  return {
    dependencies: {
      config: {
        authority_id: AUTHORITY_ID,
        organization_id: ORGANIZATION_ID,
        state_directory: '/private/state',
        database_path: '/private/state/authority.sqlite',
        organization_recording_policy_v1: {
          schema_version: 1,
          kind: 'organization-recording-policy-v1',
          decision_processor_adapter_instance_id: 'primary',
          approval_surface_adapter_instance_id: 'internal-approvals',
          presentation_mode: 'organization-member-readable-v1',
          policy_contract_sha256:
            organizationMemberReadablePolicyContractSha256(),
        },
      } as never,
      authority: {} as never,
      authorityRepository: authorityRepository as never,
      authorizationFence: {} as never,
      integrations: {} as never,
      integrationsRepository: {
        activeSlackApprovalRuntimeBinding: runtimeBinding,
      } as never,
      integrationSecrets: { read: readSecret } as never,
      records: {
        organizationMemberReadableHealth: { kind: 'ready' },
      } as never,
    },
    enrollmentByInstallation,
    membership,
    readSecret,
    runtimeBinding,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  seams.inspectKey.mockReset();
  seams.readSourceBinding.mockReset();
});

describe('Authority meeting processing runtime binding', () => {
  it('keeps polling disabled when the current key has no complete policy-surface binding', async () => {
    seams.readSourceBinding.mockReturnValue({
      organization_id: ORGANIZATION_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      membership_type: 'employee',
      source_adapter_id: 'granola',
      source_instance_id: 'granola-primary',
      owner_email_sha256: `sha256:${'b'.repeat(64)}`,
      credential_scope: 'organization',
      credential_reference_sha256: `sha256:${'c'.repeat(64)}`,
    });
    seams.inspectKey.mockReturnValue({
      installation_id: INSTALLATION_ID,
      key_id: KEY_ID,
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: PUBLIC_KEY,
    });
    const fixture = options({ runtimeBinding: null });
    const diagnostic = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);

    await expect(
      openAuthorityMeetingProcessingRuntime(fixture.dependencies),
    ).resolves.toBeNull();
    expect(fixture.enrollmentByInstallation).toHaveBeenCalledWith(
      INSTALLATION_ID,
    );
    expect(fixture.runtimeBinding).toHaveBeenCalledWith(
      'internal-approvals',
      INSTALLATION_ID,
      KEY_ID,
    );
    expect(fixture.membership).not.toHaveBeenCalled();
    expect(fixture.readSecret).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledOnce();
  });

  it('rejects an unenrolled processing key before resolving Slack state', async () => {
    seams.readSourceBinding.mockReturnValue({
      organization_id: ORGANIZATION_ID,
      principal_id: PRINCIPAL_ID,
      membership_id: MEMBERSHIP_ID,
      membership_type: 'employee',
      source_adapter_id: 'granola',
      source_instance_id: 'granola-primary',
      owner_email_sha256: `sha256:${'b'.repeat(64)}`,
      credential_scope: 'organization',
      credential_reference_sha256: `sha256:${'c'.repeat(64)}`,
    });
    seams.inspectKey.mockReturnValue({
      installation_id: INSTALLATION_ID,
      key_id: KEY_ID,
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: PUBLIC_KEY,
    });
    const fixture = options({
      enrollmentKeyId: `sha256:${'d'.repeat(64)}`,
      runtimeBinding: null,
    });

    await expect(
      openAuthorityMeetingProcessingRuntime(fixture.dependencies),
    ).rejects.toThrow(
      'server installation key does not match the active Authority enrollment',
    );
    expect(fixture.runtimeBinding).not.toHaveBeenCalled();
    expect(fixture.readSecret).not.toHaveBeenCalled();
  });
});

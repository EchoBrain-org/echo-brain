import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  federationId,
} from '@echo-brain/federation-protocol';
import {
  organizationAuthorityPinSha256,
  organizationMemberReadablePolicyContractSha256,
} from '@echo-brain/organization-protocol';
import { readOrganizationMemberRecordingActivation } from '../src/adapters/persistence/sqlite/organization-recording-policy-activation.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import {
  validateOrganizationMemberRecordingActivationCommand,
  type OrganizationMemberRecordingActivationCommandV1,
} from '../src/application/organization-recording-policy-activation.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';
import {
  activateOrganizationMemberRecording,
  initializeDevelopmentAuthority,
  resolveEffectiveAuthorityServeConfig,
} from '../src/composition/operator-state.js';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
} from '../src/composition/operator-config.js';
import { inspectAuthorityStatus } from '../src/composition/status.js';
import { seedActiveSlackApprovalSurface } from './support/active-slack-approval-surface.js';

interface ActivationFixture {
  readonly root: string;
  readonly configPath: string;
  readonly databasePath: string;
  readonly commandPath: string;
  readonly command: OrganizationMemberRecordingActivationCommandV1;
  readonly employee: StoredAuthorityMembership;
  readonly revokedOwner: StoredAuthorityMembership;
}

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

function membership(input: {
  organizationId: string;
  displayName: string;
  membershipType: 'owner' | 'employee';
  provisionedAt: string;
}): StoredAuthorityMembership {
  return {
    organization_id: input.organizationId,
    principal_id: federationId('prn'),
    membership_id: federationId('mem'),
    display_name: input.displayName,
    membership_type: input.membershipType,
    status: 'active',
    provisioned_at: input.provisionedAt,
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: `adm_${randomUUID()}`,
    admin_command_sha256: canonicalSha256({
      schema_version: 1,
      kind: 'test-recording-activation-membership',
      membership_id: input.displayName,
    }),
  };
}

function writeCanonical(path: string, value: unknown): void {
  writeFileSync(path, canonicalJson(value as never), { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function fixture(options: {
  readonly approval_surface_adapter_instance_id?: string | null;
} = {}): Promise<ActivationFixture> {
  const root = realpathSync(mkdtempSync('/tmp/erav-'));
  temporaryDirectories.push(root);
  chmodSync(root, 0o700);
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'state');
  const initialized = await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Activation Validation Company',
  });
  const runtimeConfig = readAuthorityRuntimeConfig(configPath);
  const paths = authorityStatePaths(stateDirectory);
  const database = new Database(runtimeConfig.database_path, {
    readonly: true,
  });
  const observedAt = (
    database
      .prepare(
        'SELECT last_observed_at FROM authority_metadata WHERE singleton = 1',
      )
      .get() as { last_observed_at: string }
  ).last_observed_at;
  database.close();

  const employee = membership({
    organizationId: initialized.authority_descriptor.organization_id,
    displayName: 'Active Employee',
    membershipType: 'employee',
    provisionedAt: plus(observedAt, 1),
  });
  const revokedOwner = membership({
    organizationId: initialized.authority_descriptor.organization_id,
    displayName: 'Revoked Owner',
    membershipType: 'owner',
    provisionedAt: plus(observedAt, 2),
  });
  const activeOwner = membership({
    organizationId: initialized.authority_descriptor.organization_id,
    displayName: 'Active Owner',
    membershipType: 'owner',
    provisionedAt: plus(observedAt, 4),
  });
  const repository = new SqliteOrganizationAuthorityRepository(
    runtimeConfig.database_path,
    { fileMustExist: true, allowInitialization: false },
  );
  repository.initialize({
    descriptor: initialized.authority_descriptor,
    authority_pin_sha256: organizationAuthorityPinSha256(
      initialized.authority_descriptor,
    ),
    organization_display_name: 'Activation Validation Company',
    initialized_at: plus(observedAt, 1),
  });
  repository.write(plus(observedAt, 4), (transaction) => {
    transaction.insertMembership(employee);
    transaction.insertMembership(revokedOwner);
    expect(
      transaction.revokeMembership(
        revokedOwner.membership_id,
        plus(observedAt, 3),
        'Owner access was revoked before activation',
      ),
    ).toBe(true);
    transaction.insertMembership(activeOwner);
  });
  repository.close();
  if (options.approval_surface_adapter_instance_id !== null) {
    seedActiveSlackApprovalSurface({
      integrations_database_path: paths.integrations_database_path,
      organization_id: initialized.authority_descriptor.organization_id,
      authority_id: initialized.authority_descriptor.authority_id,
      owner: activeOwner,
      installation: {
        installation_id: federationId('ins'),
        installation_key_id: canonicalSha256({
          schema_version: 1,
          kind: 'test-activation-validation-installation-key',
        }),
      },
      adapter_instance_id:
        options.approval_surface_adapter_instance_id ??
        'slack-reactions-primary',
      activated_at: activeOwner.provisioned_at,
    });
  }

  const manifest = JSON.parse(
    readFileSync(paths.initialization_manifest_path, 'utf8'),
  ) as { runtime_config: unknown; [key: string]: unknown };
  const command = {
    schema_version: 1,
    kind: 'echo-organization-member-recording-activation-command',
    command_id: `rpa_${randomUUID()}`,
    authority_id: initialized.authority_descriptor.authority_id,
    organization_id: initialized.authority_descriptor.organization_id,
    initialized_runtime_config_sha256: canonicalSha256(
      manifest.runtime_config as never,
    ),
    initialization_manifest_sha256: canonicalSha256(manifest as never),
    owner_principal_id: activeOwner.principal_id,
    owner_membership_id: activeOwner.membership_id,
    target_policy: {
      schema_version: 1,
      kind: 'organization-recording-policy-v1',
      decision_processor_adapter_instance_id: 'decision-processor-primary',
      approval_surface_adapter_instance_id: 'slack-reactions-primary',
      presentation_mode: 'organization-member-readable-v1',
      policy_contract_sha256:
        organizationMemberReadablePolicyContractSha256(),
    },
    requested_at: plus(observedAt, 5),
    reason: 'Enable member-readable recording after validation',
  } satisfies OrganizationMemberRecordingActivationCommandV1;
  const commandPath = join(root, 'activate-member-recording.json');
  writeCanonical(commandPath, command);
  return {
    root,
    configPath,
    databasePath: runtimeConfig.database_path,
    commandPath,
    command,
    employee,
    revokedOwner,
  };
}

describe('organization-member recording activation validation', () => {
  it('rejects unsupported policy values and non-NFC operator reasons', () => {
    const base = {
      schema_version: 1,
      kind: 'echo-organization-member-recording-activation-command',
      command_id: `rpa_${randomUUID()}`,
      authority_id: federationId('oau'),
      organization_id: federationId('org'),
      initialized_runtime_config_sha256: `sha256:${'a'.repeat(64)}`,
      initialization_manifest_sha256: `sha256:${'b'.repeat(64)}`,
      owner_principal_id: federationId('prn'),
      owner_membership_id: federationId('mem'),
      target_policy: {
        schema_version: 1,
        kind: 'organization-recording-policy-v1',
        decision_processor_adapter_instance_id: 'decision-processor-primary',
        approval_surface_adapter_instance_id: 'slack-reactions-primary',
        presentation_mode: 'organization-member-readable-v1',
        policy_contract_sha256:
          organizationMemberReadablePolicyContractSha256(),
      },
      requested_at: '2026-08-13T12:00:00.000Z',
      reason: 'Enable member-readable recording',
    } as const;

    for (const value of [
      {
        ...base,
        target_policy: {
          ...base.target_policy,
          presentation_mode: 'restricted-reviewer-v1',
        },
      },
      {
        ...base,
        target_policy: {
          ...base.target_policy,
          policy_contract_sha256: `sha256:${'c'.repeat(64)}`,
        },
      },
    ]) {
      expect(() =>
        validateOrganizationMemberRecordingActivationCommand(value),
      ).toThrow('target policy is unsupported');
    }
    expect(() =>
      validateOrganizationMemberRecordingActivationCommand({
        ...base,
        reason: 'Cafe\u0301 activation',
      }),
    ).toThrow('reason is invalid');
  });

  it('requires a private canonical command file', async () => {
    const context = await fixture();
    writeFileSync(
      context.commandPath,
      JSON.stringify(context.command, null, 2),
      { mode: 0o600 },
    );
    await expect(
      activateOrganizationMemberRecording(
        context.configPath,
        context.commandPath,
      ),
    ).rejects.toThrow('canonical');

    writeCanonical(context.commandPath, context.command);
    chmodSync(context.commandPath, 0o644);
    await expect(
      activateOrganizationMemberRecording(
        context.configPath,
        context.commandPath,
      ),
    ).rejects.toThrow('0600');
    expect(
      readOrganizationMemberRecordingActivation(context.databasePath),
    ).toBeNull();
  });

  it('refuses stale or future requests, changed baselines, and ineligible owners', async () => {
    const context = await fixture();
    const attempt = async (
      command: OrganizationMemberRecordingActivationCommandV1,
      now = context.command.requested_at,
    ): Promise<void> => {
      writeCanonical(context.commandPath, command);
      await activateOrganizationMemberRecording(
        context.configPath,
        context.commandPath,
        { now: () => now },
      );
    };

    await expect(
      attempt(
        context.command,
        plus(context.command.requested_at, 5 * 60_000 + 1),
      ),
    ).rejects.toThrow('outside five minutes');
    await expect(
      attempt(
        context.command,
        plus(context.command.requested_at, -(5 * 60_000 + 1)),
      ),
    ).rejects.toThrow('outside five minutes');

    for (const command of [
      {
        ...context.command,
        initialized_runtime_config_sha256: `sha256:${'d'.repeat(64)}`,
      },
      {
        ...context.command,
        initialization_manifest_sha256: `sha256:${'e'.repeat(64)}`,
      },
    ] satisfies OrganizationMemberRecordingActivationCommandV1[]) {
      await expect(attempt(command)).rejects.toThrow(
        'does not match the immutable initialized baseline',
      );
    }

    for (const candidate of [context.employee, context.revokedOwner]) {
      await expect(
        attempt({
          ...context.command,
          owner_principal_id: candidate.principal_id,
          owner_membership_id: candidate.membership_id,
        }),
      ).rejects.toThrow('requires the current active owner');
    }
    expect(
      readOrganizationMemberRecordingActivation(context.databasePath),
    ).toBeNull();
  });

  it('requires an exact active Slack approval-surface binding', async () => {
    for (const approvalSurfaceAdapterInstanceId of [
      null,
      'slack-reactions-secondary',
    ]) {
      const context = await fixture({
        approval_surface_adapter_instance_id: approvalSurfaceAdapterInstanceId,
      });
      await expect(
        activateOrganizationMemberRecording(
          context.configPath,
          context.commandPath,
          { now: () => context.command.requested_at },
        ),
      ).rejects.toThrow(
        'requires an exact active Slack approval-surface instance',
      );
      expect(
        readOrganizationMemberRecordingActivation(context.databasePath),
      ).toBeNull();
    }
  });

  it('fails config resolution and status closed after marker or audit tamper', async () => {
    const context = await fixture();
    writeCanonical(context.commandPath, context.command);
    const activated = await activateOrganizationMemberRecording(
      context.configPath,
      context.commandPath,
      { now: () => context.command.requested_at },
    );
    const database = new Database(context.databasePath);
    database.exec(
      'DROP TRIGGER authority_organization_member_recording_activation_immutable_update',
    );
    database
      .prepare(
        `UPDATE authority_organization_member_recording_activation
            SET activation_sha256 = ?
          WHERE singleton = 1`,
      )
      .run(`sha256:${'f'.repeat(64)}`);
    database.close();

    expect(() =>
      readOrganizationMemberRecordingActivation(context.databasePath),
    ).toThrow('activation');
    expect(() =>
      resolveEffectiveAuthorityServeConfig(
        context.configPath,
        readAuthorityRuntimeConfig(context.configPath),
      ),
    ).toThrow('activation');
    await expect(inspectAuthorityStatus(context.configPath)).resolves.toMatchObject({
      ok: false,
      initialized: false,
      running: false,
    });

    const restore = new Database(context.databasePath);
    restore
      .prepare(
        `UPDATE authority_organization_member_recording_activation
            SET activation_sha256 = ?
          WHERE singleton = 1`,
      )
      .run(activated.activation.activation_sha256);
    expect(
      readOrganizationMemberRecordingActivation(context.databasePath),
    ).toEqual(activated.activation);
    restore.exec(
      'DROP TRIGGER authority_audit_log_recording_activation_immutable_update',
    );
    restore
      .prepare(
        `UPDATE authority_audit_log
            SET detail_json = '{}'
          WHERE audit_sequence = ?`,
      )
      .run(activated.activation.audit_sequence);
    restore.close();

    expect(() =>
      readOrganizationMemberRecordingActivation(context.databasePath),
    ).toThrow('activation audit is invalid');
    expect(() =>
      resolveEffectiveAuthorityServeConfig(
        context.configPath,
        readAuthorityRuntimeConfig(context.configPath),
      ),
    ).toThrow('activation audit is invalid');
    await expect(inspectAuthorityStatus(context.configPath)).resolves.toMatchObject({
      ok: false,
      initialized: false,
      running: false,
    });
  });
});

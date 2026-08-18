import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createNetServer } from 'node:net';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalJson,
  canonicalSha256,
  federationId,
} from '@echo-brain/federation-protocol';
import { FileOrganizationSecretStore } from '@echo-brain/organization-control-plane';
import {
  organizationAuthorityPinSha256,
  organizationMemberReadablePolicyContractSha256,
} from '@echo-brain/organization-protocol';
import { readOrganizationMemberRecordingActivation } from '../src/adapters/persistence/sqlite/organization-recording-policy-activation.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { authorityRuntimeFingerprint } from '../src/adapters/runtime/runtime-fingerprint.js';
import { inspectAuthorityRuntimeLock } from '../src/adapters/runtime/singleton-runtime-lock.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';
import {
  ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION,
  type OrganizationMemberRecordingActivationCommandV1,
} from '../src/application/organization-recording-policy-activation.js';
import {
  activateOrganizationMemberRecording,
  initializeDevelopmentAuthority,
  resolveEffectiveAuthorityServeConfig,
} from '../src/composition/operator-state.js';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from '../src/composition/operator-config.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';
import { inspectAuthorityStatus } from '../src/composition/status.js';
import { seedActiveSlackApprovalSurface } from './support/active-slack-approval-surface.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function plus(timestamp: string, milliseconds: number): string {
  return new Date(Date.parse(timestamp) + milliseconds).toISOString();
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('test could not reserve a loopback port');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}

function privateCanonicalJson(path: string, value: unknown): void {
  writeFileSync(path, canonicalJson(value as never), { mode: 0o600 });
  chmodSync(path, 0o600);
}

function downgradeToPreActivationSchema(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.exec(`
      DROP TRIGGER authority_person_read_decision_audit_immutable_update;
      DROP TRIGGER authority_person_read_decision_audit_delete_denied;
      DROP TABLE authority_person_read_decision_audit;
      DROP TRIGGER authority_person_login_grants_initial_state_insert;
      DROP TRIGGER authority_oidc_identity_bindings_provenance_insert;
      DROP TRIGGER authority_oidc_identity_bindings_terminal_update;
      DROP TRIGGER authority_oidc_identity_bindings_revoke_families;
      DROP TRIGGER authority_oidc_identity_bindings_delete_denied;
      DROP TRIGGER authority_oidc_login_attempts_bootstrap_grant_insert;
      DROP TRIGGER authority_oidc_login_attempts_initial_state_insert;
      DROP TRIGGER authority_oidc_login_attempts_terminal_bootstrap_grant;
      DROP TRIGGER authority_oidc_login_attempts_state_transition_only;
      DROP TRIGGER authority_oidc_login_attempts_delete_denied;
      DROP TRIGGER authority_person_login_grants_consume_only;
      DROP TRIGGER authority_person_login_grants_delete_denied;
      DROP TRIGGER authority_person_session_families_provenance_insert;
      DROP TRIGGER authority_person_session_families_terminal_update;
      DROP TRIGGER authority_person_session_families_revoke_credentials;
      DROP TRIGGER authority_person_session_families_delete_denied;
      DROP TRIGGER authority_memberships_revoke_person_session_families;
      DROP TRIGGER authority_person_session_credentials_policy_insert;
      DROP TRIGGER authority_person_session_credentials_initial_state_insert;
      DROP TRIGGER authority_person_session_credentials_contiguous;
      DROP TRIGGER authority_person_session_credentials_terminal_update;
      DROP TRIGGER authority_person_session_credentials_delete_denied;
      DROP TABLE authority_person_session_credentials;
      DROP TABLE authority_person_session_families;
      DROP TABLE authority_oidc_identity_bindings;
      DROP TABLE authority_oidc_login_attempts;
      DROP TABLE authority_person_login_grants;
      DROP TRIGGER authority_audit_log_recording_activation_immutable_update;
      DROP TRIGGER authority_audit_log_recording_activation_delete_denied;
      DROP TABLE authority_organization_member_recording_activation;
      PRAGMA user_version = 7;
    `);
  } finally {
    database.close();
  }
}

describe('organization-member recording activation lifecycle', () => {
  it('migrates, commits marker plus audit atomically, replays exactly, and binds runtime status', async () => {
    const root = realpathSync(mkdtempSync('/tmp/era-'));
    temporaryDirectories.push(root);
    chmodSync(root, 0o700);
    const configPath = join(root, 'authority.json');
    const stateDirectory = join(root, 'state');
    const initialized = await initializeDevelopmentAuthority({
      config_path: configPath,
      state_directory: stateDirectory,
      organization_display_name: 'Activation Company',
      port: await reserveLoopbackPort(),
    });
    const runtimeConfig = readAuthorityRuntimeConfig(configPath);
    const paths = authorityStatePaths(stateDirectory);
    const metadataDatabase = new Database(runtimeConfig.database_path, {
      readonly: true,
    });
    const lastObservedAt = (
      metadataDatabase
        .prepare('SELECT last_observed_at FROM authority_metadata WHERE singleton = 1')
        .get() as { last_observed_at: string }
    ).last_observed_at;
    metadataDatabase.close();

    const configuredAt = plus(lastObservedAt, 1);
    const owner: StoredAuthorityMembership = {
      organization_id: initialized.authority_descriptor.organization_id,
      principal_id: federationId('prn'),
      membership_id: federationId('mem'),
      display_name: 'Activation Owner',
      membership_type: 'owner',
      status: 'active',
      provisioned_at: plus(configuredAt, 1),
      revoked_at: null,
      revocation_reason: null,
      admin_command_id: `adm_${randomUUID()}`,
      admin_command_sha256: canonicalSha256({
        schema_version: 1,
        kind: 'test-activation-owner-provisioning',
      }),
    };
    const repository = new SqliteOrganizationAuthorityRepository(
      runtimeConfig.database_path,
      { fileMustExist: true, allowInitialization: false },
    );
    repository.initialize({
      descriptor: initialized.authority_descriptor,
      authority_pin_sha256: organizationAuthorityPinSha256(
        initialized.authority_descriptor,
      ),
      organization_display_name: 'Activation Company',
      initialized_at: configuredAt,
    });
    repository.write(owner.provisioned_at, (transaction) => {
      transaction.insertMembership(owner);
    });
    expect(() =>
      repository.write(plus(owner.provisioned_at, 1), (transaction) => {
        transaction.appendAudit({
          occurred_at: plus(owner.provisioned_at, 1),
          actor_kind: 'admin',
          action: ORGANIZATION_MEMBER_RECORDING_ACTIVATED_ACTION,
          subject_id: owner.organization_id,
          detail: {},
        });
      }),
    ).toThrow('reserved for their maintenance transaction');
    repository.close();
    const slackSecret = new FileOrganizationSecretStore(
      join(stateDirectory, 'credentials', 'integrations'),
    ).create('xoxb-test-activation-token');
    seedActiveSlackApprovalSurface({
      integrations_database_path: paths.integrations_database_path,
      organization_id: initialized.authority_descriptor.organization_id,
      authority_id: initialized.authority_descriptor.authority_id,
      owner: owner,
      installation: {
        installation_id: federationId('ins'),
        installation_key_id: canonicalSha256({
          schema_version: 1,
          kind: 'test-activation-installation-key',
        }),
      },
      secret_handle_id: slackSecret.secret_handle_id,
      adapter_instance_id: 'slack-reactions-primary',
      activated_at: owner.provisioned_at,
    });

    const manifest = JSON.parse(
      readFileSync(paths.initialization_manifest_path, 'utf8'),
    ) as {
      runtime_config: unknown;
      [key: string]: unknown;
    };
    let requestedAt = owner.provisioned_at;
    let command: OrganizationMemberRecordingActivationCommandV1 = {
      schema_version: 1,
      kind: 'echo-organization-member-recording-activation-command',
      command_id: `rpa_${randomUUID()}`,
      authority_id: initialized.authority_descriptor.authority_id,
      organization_id: initialized.authority_descriptor.organization_id,
      initialized_runtime_config_sha256: canonicalSha256(
        manifest.runtime_config as never,
      ),
      initialization_manifest_sha256: canonicalSha256(manifest as never),
      owner_principal_id: owner.principal_id,
      owner_membership_id: owner.membership_id,
      target_policy: {
        schema_version: 1,
        kind: 'organization-recording-policy-v1',
        decision_processor_adapter_instance_id: 'decision-processor-primary',
        approval_surface_adapter_instance_id: 'slack-reactions-primary',
        presentation_mode: 'organization-member-readable-v1',
        policy_contract_sha256:
          organizationMemberReadablePolicyContractSha256(),
      },
      requested_at: requestedAt,
      reason: 'Enable member-readable recording after live verification',
    };
    const commandPath = join(root, 'activate-member-recording.json');
    privateCanonicalJson(commandPath, command);

    // A direct composition caller cannot synthesize the member policy and
    // bypass the persisted activation head. Only the immutable initialized
    // baseline or the verified additive overlay may supply runtime policy.
    await expect(
      startOrganizationAuthority({
        ...resolveAuthorityServeConfig(runtimeConfig),
        organization_recording_policy_v1: command.target_policy,
      }),
    ).rejects.toThrow(
      'organization recording policy differs from the immutable initialized baseline',
    );

    // A running pre-activation runtime excludes maintenance before any
    // migration or activation write can occur.
    downgradeToPreActivationSchema(runtimeConfig.database_path);
    const runningBeforeActivation = await startOrganizationAuthority(
      resolveAuthorityServeConfig(runtimeConfig),
    );
    try {
      await expect(
        activateOrganizationMemberRecording(configPath, commandPath, {
          now: () => requestedAt,
        }),
      ).rejects.toThrow('already running for this state directory');
    } finally {
      await runningBeforeActivation.close();
    }
    expect(
      readOrganizationMemberRecordingActivation(runtimeConfig.database_path),
    ).toBeNull();

    // The pre-activation runtime may advance the monotonic Authority clock.
    // Bind the real command to the first current instant after that probe, so
    // it is fresh without forcing the next runtime to wait for a future clock.
    requestedAt = new Date().toISOString();
    command = { ...command, requested_at: requestedAt };
    privateCanonicalJson(commandPath, command);

    // Restore the exact v7 starting point to prove the activation command,
    // rather than an earlier runtime start, owns the forward migration.
    downgradeToPreActivationSchema(runtimeConfig.database_path);
    const configBefore = readFileSync(configPath);
    const manifestBefore = readFileSync(paths.initialization_manifest_path);
    await expect(
      activateOrganizationMemberRecording(configPath, commandPath, {
        now: () => requestedAt,
        fault_after_audit: () => {
          throw new Error('fault:after-audit');
        },
      }),
    ).rejects.toThrow('fault:after-audit');

    const rolledBack = new Database(runtimeConfig.database_path);
    expect(rolledBack.pragma('user_version', { simple: true })).toBe(10);
    expect(
      (
        rolledBack
          .prepare(
            `SELECT COUNT(*) AS count
               FROM authority_audit_log
              WHERE action = 'configuration.organization_member_recording_activated'`,
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    expect(
      (
        rolledBack
          .prepare(
            'SELECT COUNT(*) AS count FROM authority_organization_member_recording_activation',
          )
          .get() as { count: number }
      ).count,
    ).toBe(0);
    rolledBack.close();

    const activated = await activateOrganizationMemberRecording(
      configPath,
      commandPath,
      { now: () => requestedAt },
    );
    expect(activated.created).toBe(true);
    expect(readFileSync(configPath)).toEqual(configBefore);
    expect(readFileSync(paths.initialization_manifest_path)).toEqual(
      manifestBefore,
    );
    expect(
      readOrganizationMemberRecordingActivation(runtimeConfig.database_path),
    ).toEqual(activated.activation);

    const replay = await activateOrganizationMemberRecording(
      configPath,
      commandPath,
    );
    const secondReplay = await activateOrganizationMemberRecording(
      configPath,
      commandPath,
    );
    expect(replay.created).toBe(false);
    expect(canonicalJson(secondReplay as never)).toBe(
      canonicalJson(replay as never),
    );

    privateCanonicalJson(commandPath, {
      ...command,
      command_id: `rpa_${randomUUID()}`,
    });
    await expect(
      activateOrganizationMemberRecording(configPath, commandPath),
    ).rejects.toThrow('already activated by a different command');

    const immutable = new Database(runtimeConfig.database_path);
    expect(() =>
      immutable
        .prepare(
          'UPDATE authority_organization_member_recording_activation SET activated_at = activated_at',
        )
        .run(),
    ).toThrow('activation is immutable');
    expect(() =>
      immutable
        .prepare(
          `DELETE FROM authority_audit_log
            WHERE action = 'configuration.organization_member_recording_activated'`,
        )
        .run(),
    ).toThrow('activation audit cannot be deleted');
    immutable.close();

    const rawServeConfig = resolveAuthorityServeConfig(runtimeConfig);
    await expect(startOrganizationAuthority(rawServeConfig)).rejects.toThrow(
      'activation changed before runtime composition',
    );

    const effective = resolveEffectiveAuthorityServeConfig(
      configPath,
      runtimeConfig,
    );
    expect(effective.organization_recording_policy_v1).toEqual(
      command.target_policy,
    );
    expect(effective.organization_member_recording_activation_v1).toBeDefined();
    expect(authorityRuntimeFingerprint(effective)).not.toBe(
      authorityRuntimeFingerprint(rawServeConfig),
    );
    const runtime = await startOrganizationAuthority(effective);
    try {
      const lock = await inspectAuthorityRuntimeLock(stateDirectory);
      expect(lock.runtime_fingerprint_sha256).toBe(
        authorityRuntimeFingerprint(effective),
      );
      expect(await inspectAuthorityStatus(configPath)).toMatchObject({
        ok: true,
        initialized: true,
        running: true,
        healthy: true,
      });
    } finally {
      await runtime.close();
    }
  });
});

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Digest } from '@echo-brain/federation-protocol';
import {
  ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND,
  ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
  ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
  organizationPermissionPilotCommandSha256,
  type OrganizationPermissionPilotActivationCommandV1,
  type OrganizationPermissionPilotActivationMarkerV1,
} from '@echo-brain/organization-record';
import {
  OrganizationPermissionPilotLog,
  OrganizationRecordLogStore,
} from '@echo-brain/organization-record/maintenance';
import { acquireAuthorityRuntimeLock } from '../src/adapters/runtime/singleton-runtime-lock.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  type AuthorityRuntimeConfigV1,
} from '../src/composition/operator-config.js';
import {
  activateOrganizationPermissionPilot,
  initializeDevelopmentAuthority,
} from '../src/composition/operator-state.js';

const NOW = '2026-08-10T08:00:00.000Z';
const MEMBERS = Object.freeze([
  {
    principal_id: 'prn_00000000-0000-4000-8000-000000000001',
    membership_id: 'mem_00000000-0000-4000-8000-000000000001',
    label: 'Ada Founder',
  },
  {
    principal_id: 'prn_00000000-0000-4000-8000-000000000002',
    membership_id: 'mem_00000000-0000-4000-8000-000000000002',
    label: 'Grace Operator',
  },
  {
    principal_id: 'prn_00000000-0000-4000-8000-000000000003',
    membership_id: 'mem_00000000-0000-4000-8000-000000000003',
    label: 'Linus Observer',
  },
]);

interface Fixture {
  root: string;
  config_path: string;
  state_directory: string;
  config: AuthorityRuntimeConfigV1;
}

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function fixture(): Promise<Fixture> {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-ppa-')),
  );
  roots.push(root);
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'state');
  await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Example Company',
  });
  const config = readAuthorityRuntimeConfig(configPath);
  seedActiveMembers(config);
  return {
    root,
    config_path: configPath,
    state_directory: stateDirectory,
    config,
  };
}

function seedActiveMembers(config: AuthorityRuntimeConfigV1): void {
  const database = new Database(config.database_path, {
    fileMustExist: true,
  });
  try {
    database.pragma('foreign_keys = ON');
    const insertPrincipal = database.prepare(
      `INSERT INTO authority_principals (
         principal_id, organization_id, display_name, provisioned_at
       ) VALUES (?, ?, ?, ?)`,
    );
    const insertMembership = database.prepare(
      `INSERT INTO authority_memberships (
         membership_id, organization_id, principal_id, membership_type,
         status, provisioned_at, revoked_at, revocation_reason,
         admin_command_id, admin_command_sha256
       ) VALUES (?, ?, ?, 'employee', 'active', ?, NULL, NULL, ?, ?)`,
    );
    database.transaction(() => {
      for (const [index, member] of MEMBERS.entries()) {
        insertPrincipal.run(
          member.principal_id,
          config.organization.organization_id,
          member.label,
          NOW,
        );
        insertMembership.run(
          member.membership_id,
          config.organization.organization_id,
          member.principal_id,
          NOW,
          `adm_00000000-0000-4000-8000-00000000000${index + 1}`,
          `sha256:${String(index + 1).repeat(64)}`,
        );
      }
    })();
  } finally {
    database.close();
  }
}

function command(
  fixtureValue: Fixture,
  overrides: Partial<OrganizationPermissionPilotActivationCommandV1> = {},
): OrganizationPermissionPilotActivationCommandV1 {
  return {
    schema_version: 1,
    kind: ORGANIZATION_PERMISSION_PILOT_ACTIVATION_COMMAND_KIND,
    command_id: 'ppa_00000000-0000-4000-8000-000000000001',
    authority_id: fixtureValue.config.authority.authority_id,
    organization_id: fixtureValue.config.organization.organization_id,
    policy_id: ORGANIZATION_PERMISSION_PILOT_POLICY_ID,
    presentation_policy_id:
      ORGANIZATION_PERMISSION_PILOT_PRESENTATION_POLICY_ID,
    audience: [
      {
        membership_id: MEMBERS[0].membership_id,
        label: MEMBERS[0].label,
      },
      {
        membership_id: MEMBERS[1].membership_id,
        label: MEMBERS[1].label,
      },
    ],
    requested_at: NOW,
    reason: 'Operator-confirmed two-person post-activation read pilot.',
    ...overrides,
  };
}

function writeCommand(
  fixtureValue: Fixture,
  value: OrganizationPermissionPilotActivationCommandV1,
  filename = 'activate-permission-pilot.json',
): string {
  return writeRawCommand(fixtureValue, value, filename);
}

function writeRawCommand(
  fixtureValue: Fixture,
  value: unknown,
  filename = 'activate-permission-pilot.json',
): string {
  const path = join(fixtureValue.root, filename);
  writeFileSync(path, `${canonicalJson(value as never)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  return path;
}

function readActivation(
  fixtureValue: Fixture,
): OrganizationPermissionPilotActivationMarkerV1 | null {
  const log = OrganizationPermissionPilotLog.open(
    authorityStatePaths(fixtureValue.state_directory).record_log_database_path,
    {
      organization_id: fixtureValue.config.organization.organization_id,
      authority_id: fixtureValue.config.authority.authority_id,
    },
  );
  try {
    return log.activation();
  } finally {
    log.close();
  }
}

function appendRecord(fixtureValue: Fixture): `sha256:${string}` {
  const envelope = {
    schema_version: 1,
    event_type: 'rejection',
    envelope_id: 'rec_00000000-0000-4000-8000-000000000001',
    idempotency_key: '1'.repeat(64),
    payload: {
      schema_version: 1,
      source: {
        adapter_id: 'granola',
        instance_id: 'primary',
        external_id: 'granola-permission-pilot-boundary',
      },
      meeting_id: 'meeting-permission-pilot-boundary',
      rejected_at: '2026-08-10T08:00:01.000Z',
      reason: 'Not an organization decision',
      reconsider_after: null,
    },
    reviewer: {
      principal_id: MEMBERS[0].principal_id,
      reviewed_by: MEMBERS[0].label,
    },
    intent: { restricted: true },
    submitter: {
      installation_id: 'ins_00000000-0000-4000-8000-000000000001',
    },
  } as const;
  const canonicalEnvelope = canonicalJson(envelope);
  const log = OrganizationRecordLogStore.open(
    authorityStatePaths(fixtureValue.state_directory).record_log_database_path,
    {
      organization_id: fixtureValue.config.organization.organization_id,
      authority_id: fixtureValue.config.authority.authority_id,
    },
  );
  try {
    return log.append({
      envelope: {
        envelope,
        envelope_id: envelope.envelope_id,
        event_type: envelope.event_type,
        installation_id: 'ins_00000000-0000-4000-8000-000000000001',
        idempotency_key: envelope.idempotency_key,
      },
      canonical_envelope: canonicalEnvelope,
      envelope_sha256: sha256Digest(canonicalEnvelope),
    }).row.record_hash;
  } finally {
    log.close();
  }
}

function revokeFirstMember(fixtureValue: Fixture): void {
  const database = new Database(fixtureValue.config.database_path, {
    fileMustExist: true,
  });
  try {
    database
      .prepare(
        `UPDATE authority_memberships
         SET status = 'revoked', revoked_at = ?, revocation_reason = ?
         WHERE membership_id = ?`,
      )
      .run(
        '2026-08-10T08:00:02.000Z',
        'Pilot retry ordering test',
        MEMBERS[0].membership_id,
      );
  } finally {
    database.close();
  }
}

const INVALID_COMMAND_CASES: ReadonlyArray<{
  name: string;
  mutate: (
    value: OrganizationPermissionPilotActivationCommandV1,
  ) => unknown;
}> = [
  {
    name: 'extra key',
    mutate: (value) => ({ ...value, unexpected: true }),
  },
  {
    name: 'invalid command ID',
    mutate: (value) => ({ ...value, command_id: 'ppa_not-a-uuid' }),
  },
  {
    name: 'invalid membership ID',
    mutate: (value) => ({
      ...value,
      audience: [
        { ...value.audience[0], membership_id: 'mem_not-a-uuid' },
        value.audience[1],
      ],
    }),
  },
  {
    name: 'duplicate audience membership',
    mutate: (value) => ({
      ...value,
      audience: [
        value.audience[0],
        {
          ...value.audience[1],
          membership_id: value.audience[0].membership_id,
        },
      ],
    }),
  },
  {
    name: 'unsorted audience',
    mutate: (value) => ({
      ...value,
      audience: [value.audience[1], value.audience[0]],
    }),
  },
  {
    name: 'invalid reason',
    mutate: (value) => ({ ...value, reason: 'contains\na control' }),
  },
  {
    name: 'invalid C1 control in reason',
    mutate: (value) => ({ ...value, reason: 'contains\u0085a control' }),
  },
  {
    name: 'invalid presentation label',
    mutate: (value) => ({
      ...value,
      audience: [
        { ...value.audience[0], label: '<@U12345678>' },
        value.audience[1],
      ],
    }),
  },
];

describe('organization permission pilot activation', () => {
  it('activates from the stopped CLI and emits the exact non-secret descriptor', async () => {
    const fixtureValue = await fixture();
    const value = command(fixtureValue, {
      requested_at: new Date().toISOString(),
    });
    const commandPath = writeCommand(fixtureValue, value);
    const authorityDatabaseBefore = readFileSync(
      fixtureValue.config.database_path,
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = await runOrganizationAuthorityCli(
      [
        'activate-permission-pilot',
        '--config',
        fixtureValue.config_path,
        '--command',
        commandPath,
      ],
      {},
      {
        stdout: (output) => stdout.push(output),
        stderr: (output) => stderr.push(output),
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout).toHaveLength(1);
    const parsed = JSON.parse(stdout[0]) as {
      created: boolean;
      marker: OrganizationPermissionPilotActivationMarkerV1;
      presentation_descriptor: unknown;
    };
    expect(stdout[0]).toBe(`${canonicalJson(parsed as never)}\n`);
    expect(parsed.created).toBe(true);
    expect(parsed.marker).toMatchObject({
      command_id: value.command_id,
      command_sha256: organizationPermissionPilotCommandSha256(value),
      organization_id: value.organization_id,
      audience: value.audience,
      effective_after_position: 0,
      effective_after_record_hash: null,
    });
    expect(parsed.presentation_descriptor).toEqual(
      parsed.marker.presentation_descriptor,
    );
    expect(parsed.marker.presentation_descriptor.notice_text).toBe(
      "Approving publishes this organization record's decisions, actions, and rationales to Ada Founder and Grace Operator.",
    );
    expect(parsed.marker.audience).not.toContainEqual({
      membership_id: MEMBERS[2].membership_id,
      label: MEMBERS[2].label,
    });
    expect(readActivation(fixtureValue)).toEqual(parsed.marker);
    expect(readFileSync(fixtureValue.config.database_path)).toEqual(
      authorityDatabaseBefore,
    );

    const paths = authorityStatePaths(fixtureValue.state_directory);
    const output = stdout[0];
    expect(output).not.toContain(
      readFileSync(paths.admin_credential_path, 'utf8'),
    );
    expect(output).not.toContain(
      readFileSync(paths.proxy_credential_path, 'utf8'),
    );
  });

  it('returns an exact retry before later freshness, membership, or head changes', async () => {
    const fixtureValue = await fixture();
    const value = command(fixtureValue);
    const commandPath = writeCommand(fixtureValue, value);
    const first = await activateOrganizationPermissionPilot(
      fixtureValue.config_path,
      commandPath,
      { now: () => NOW },
    );
    appendRecord(fixtureValue);
    revokeFirstMember(fixtureValue);

    const repeated = await activateOrganizationPermissionPilot(
      fixtureValue.config_path,
      commandPath,
      { now: () => '2026-08-10T08:06:00.001Z' },
    );

    expect(first.created).toBe(true);
    expect(repeated.created).toBe(false);
    expect(repeated.marker).toEqual(first.marker);
    expect(repeated.marker.effective_after_position).toBe(0);

    const differentPath = writeCommand(
      fixtureValue,
      {
        ...value,
        command_id: 'ppa_00000000-0000-4000-8000-000000000002',
      },
      'different-activation.json',
    );
    await expect(
      activateOrganizationPermissionPilot(
        fixtureValue.config_path,
        differentPath,
        { now: () => '2026-08-10T08:06:00.001Z' },
      ),
    ).rejects.toThrow('already activated by a different command');
  });

  it('binds first creation to the exact verified nonempty log head', async () => {
    const fixtureValue = await fixture();
    const headHash = appendRecord(fixtureValue);
    const value = command(fixtureValue);
    const commandPath = writeCommand(fixtureValue, value);

    const result = await activateOrganizationPermissionPilot(
      fixtureValue.config_path,
      commandPath,
      { now: () => NOW },
    );

    expect(result.created).toBe(true);
    expect(result.marker.effective_after_position).toBe(1);
    expect(result.marker.effective_after_record_hash).toBe(headHash);
  });

  it.each(INVALID_COMMAND_CASES)(
    'refuses an activation command with $name',
    async ({ mutate }) => {
      const fixtureValue = await fixture();
      const commandPath = writeRawCommand(
        fixtureValue,
        mutate(command(fixtureValue)),
      );

      await expect(
        activateOrganizationPermissionPilot(
          fixtureValue.config_path,
          commandPath,
          { now: () => NOW },
        ),
      ).rejects.toThrow();
      expect(readActivation(fixtureValue)).toBeNull();
    },
  );

  it('refuses a missing or revoked audience membership', async () => {
    const missingFixture = await fixture();
    const missingBase = command(missingFixture);
    const missingPath = writeCommand(missingFixture, {
      ...missingBase,
      audience: [
        missingBase.audience[0],
        {
          membership_id: 'mem_00000000-0000-4000-8000-000000000099',
          label: 'Missing Person',
        },
      ],
    });
    await expect(
      activateOrganizationPermissionPilot(
        missingFixture.config_path,
        missingPath,
        { now: () => NOW },
      ),
    ).rejects.toThrow('requires both named audience memberships to be active');
    expect(readActivation(missingFixture)).toBeNull();

    const revokedFixture = await fixture();
    revokeFirstMember(revokedFixture);
    const revokedPath = writeCommand(
      revokedFixture,
      command(revokedFixture),
    );
    await expect(
      activateOrganizationPermissionPilot(
        revokedFixture.config_path,
        revokedPath,
        { now: () => NOW },
      ),
    ).rejects.toThrow('requires both named audience memberships to be active');
    expect(readActivation(revokedFixture)).toBeNull();
  });

  it('refuses stale first creation and a label that differs from Authority state', async () => {
    const staleFixture = await fixture();
    const stalePath = writeCommand(staleFixture, command(staleFixture));
    await expect(
      activateOrganizationPermissionPilot(staleFixture.config_path, stalePath, {
        now: () => '2026-08-10T08:05:00.001Z',
      }),
    ).rejects.toThrow('outside five minutes');
    expect(readActivation(staleFixture)).toBeNull();

    const labelFixture = await fixture();
    const original = command(labelFixture);
    const labelPath = writeCommand(labelFixture, {
      ...original,
      audience: [
        { ...original.audience[0], label: 'Wrong Person' },
        original.audience[1],
      ],
    });
    await expect(
      activateOrganizationPermissionPilot(labelFixture.config_path, labelPath, {
        now: () => NOW,
      }),
    ).rejects.toThrow(
      'audience labels must equal current Authority principal display names',
    );
    expect(readActivation(labelFixture)).toBeNull();
  });

  it('refuses activation while runtime ownership is live', async () => {
    const fixtureValue = await fixture();
    const commandPath = writeCommand(fixtureValue, command(fixtureValue));
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixtureValue.state_directory,
      `sha256:${'a'.repeat(64)}`,
    );
    try {
      await expect(
        activateOrganizationPermissionPilot(
          fixtureValue.config_path,
          commandPath,
          { now: () => NOW },
        ),
      ).rejects.toThrow(
        'organization authority is already running for this state directory',
      );
    } finally {
      await runtimeLock.release();
    }
    expect(readActivation(fixtureValue)).toBeNull();
  });
});

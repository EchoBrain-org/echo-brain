import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { personLoginGrantExpectedEmailSha256 } from '../src/domain/person-email-binding.js';

const seams = vi.hoisted(() => ({
  acquireInitializationLock: vi.fn(),
  acquireRuntimeLock: vi.fn(),
  maintenanceFingerprint: vi.fn(),
  readRuntimeConfig: vi.fn(),
  resolveServeConfig: vi.fn(),
  inspectPreflight: vi.fn(),
  resolveEffectiveConfig: vi.fn(),
  runOneMeeting: vi.fn(),
  releaseInitializationLock: vi.fn(),
  releaseRuntimeLock: vi.fn(),
}));

vi.mock('../src/adapters/runtime/singleton-runtime-lock.js', () => ({
  acquireAuthorityInitializationLock: seams.acquireInitializationLock,
  acquireAuthorityRuntimeLock: seams.acquireRuntimeLock,
}));

vi.mock('../src/adapters/runtime/runtime-fingerprint.js', () => ({
  authorityMaintenanceFingerprint: seams.maintenanceFingerprint,
}));

vi.mock('../src/composition/operator-config.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/composition/operator-config.js')
  >()),
  readAuthorityRuntimeConfig: seams.readRuntimeConfig,
  resolveAuthorityServeConfig: seams.resolveServeConfig,
}));

vi.mock('../src/composition/operator-state.js', () => ({
  inspectAuthorityServePreflight: seams.inspectPreflight,
  resolveEffectiveAuthorityServeConfig: seams.resolveEffectiveConfig,
}));

vi.mock('../src/processing/live/run-one-meeting.js', () => ({
  runOneAuthorityMeeting: seams.runOneMeeting,
}));

import {
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
  AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
  AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
  processOneAuthorityMeeting,
} from '../src/composition/process-one-meeting.js';

const directories: string[] = [];
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const OWNER_EMAIL = 'founder@example.com';
const GRANOLA_CREDENTIAL = `grn_${'g'.repeat(36)}`;
const BOUND_AT = '2026-08-19T20:00:00.000Z';
const RUNTIME_FINGERPRINT = `sha256:${'c'.repeat(64)}`;
const INPUT = {
  principal_id: PRINCIPAL_ID,
  membership_id: MEMBERSHIP_ID,
  membership_type: 'employee' as const,
  source_instance_id: 'founder-canary',
};

interface Fixture {
  readonly configPath: string;
  readonly stateDirectory: string;
  readonly databasePath: string;
  readonly runtimeConfig: { readonly state_dir: string };
  readonly serveConfig: { readonly marker: string };
  readonly effectiveConfig: {
    readonly state_directory: string;
    readonly database_path: string;
    readonly organization_id: string;
    readonly organization_recording_policy_v1: {
      readonly decision_processor_adapter_instance_id: string;
    };
  };
}

function privateFile(path: string, value: string): void {
  writeFileSync(path, value, { encoding: 'utf8', mode: 0o600 });
  expect(statSync(path).mode & 0o777).toBe(0o600);
}

function createFixture(ownerEmail = OWNER_EMAIL): Fixture {
  const directory = mkdtempSync(join(tmpdir(), 'echo-process-one-meeting-'));
  directories.push(directory);
  const stateDirectory = join(directory, 'state');
  const credentialDirectory = join(stateDirectory, 'credentials');
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  privateFile(
    join(
      credentialDirectory,
      AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_FILENAME,
    ),
    GRANOLA_CREDENTIAL,
  );
  privateFile(
    join(
      credentialDirectory,
      AUTHORITY_GRANOLA_ORGANIZATION_OWNER_EMAIL_FILENAME,
    ),
    ownerEmail,
  );
  privateFile(
    join(
      credentialDirectory,
      AUTHORITY_GRANOLA_ORGANIZATION_SCOPE_FILENAME,
    ),
    'organization',
  );

  const databasePath = join(stateDirectory, 'authority.sqlite');
  const database = new Database(databasePath);
  database.exec(`
    CREATE TABLE authority_memberships (
      membership_id TEXT,
      organization_id TEXT,
      principal_id TEXT,
      membership_type TEXT,
      status TEXT
    );
    CREATE TABLE authority_person_login_grants (
      login_grant_sha256 TEXT,
      organization_id TEXT,
      principal_id TEXT,
      membership_id TEXT,
      membership_type TEXT,
      expected_email_sha256 TEXT,
      consumed_at TEXT
    );
    CREATE TABLE authority_oidc_identity_bindings (
      initial_login_grant_sha256 TEXT,
      organization_id TEXT,
      principal_id TEXT,
      membership_id TEXT,
      membership_type TEXT,
      status TEXT,
      bound_at TEXT
    );
  `);
  database
    .prepare(`INSERT INTO authority_memberships VALUES (?, ?, ?, ?, 'active')`)
    .run(MEMBERSHIP_ID, ORGANIZATION_ID, PRINCIPAL_ID, 'employee');
  const grantSha256 = `sha256:${'a'.repeat(64)}`;
  database
    .prepare(
      `INSERT INTO authority_person_login_grants
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      grantSha256,
      ORGANIZATION_ID,
      PRINCIPAL_ID,
      MEMBERSHIP_ID,
      'employee',
      personLoginGrantExpectedEmailSha256(OWNER_EMAIL),
      BOUND_AT,
    );
  database
    .prepare(
      `INSERT INTO authority_oidc_identity_bindings
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    )
    .run(
      grantSha256,
      ORGANIZATION_ID,
      PRINCIPAL_ID,
      MEMBERSHIP_ID,
      'employee',
      BOUND_AT,
    );
  database.close();

  const runtimeConfig = { state_dir: stateDirectory };
  const serveConfig = { marker: 'resolved-serve-config' };
  return {
    configPath: join(directory, 'authority.json'),
    stateDirectory,
    databasePath,
    runtimeConfig,
    serveConfig,
    effectiveConfig: {
      state_directory: stateDirectory,
      database_path: databasePath,
      organization_id: ORGANIZATION_ID,
      organization_recording_policy_v1: {
        decision_processor_adapter_instance_id: 'founder-structured-text',
      },
    },
  };
}

function configure(fixture: Fixture): void {
  seams.readRuntimeConfig.mockReturnValue(fixture.runtimeConfig);
  seams.resolveServeConfig.mockReturnValue(fixture.serveConfig);
  seams.maintenanceFingerprint.mockReturnValue(RUNTIME_FINGERPRINT);
  seams.acquireInitializationLock.mockResolvedValue(
    seams.releaseInitializationLock,
  );
  seams.acquireRuntimeLock.mockResolvedValue({
    release: seams.releaseRuntimeLock,
  });
  seams.inspectPreflight.mockResolvedValue(undefined);
  seams.resolveEffectiveConfig.mockReturnValue(fixture.effectiveConfig);
  seams.runOneMeeting.mockResolvedValue({
    schema_version: 1,
    kind: 'echo-organization-authority-one-meeting-run',
    outcome: 'no_meeting',
    ok: true,
  });
}

beforeEach(() => {
  for (const seam of Object.values(seams)) seam.mockReset();
  seams.releaseInitializationLock.mockResolvedValue(undefined);
  seams.releaseRuntimeLock.mockResolvedValue(undefined);
});

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('processOneAuthorityMeeting composition', () => {
  it('binds fixed private files and the active OIDC Person identity through the locked preflight', async () => {
    const fixture = createFixture();
    configure(fixture);

    await expect(
      processOneAuthorityMeeting(fixture.configPath, INPUT),
    ).resolves.toMatchObject({ outcome: 'no_meeting', ok: true });

    expect(seams.acquireInitializationLock).toHaveBeenCalledWith(
      fixture.configPath,
      fixture.stateDirectory,
    );
    expect(seams.maintenanceFingerprint).toHaveBeenCalledWith(
      fixture.serveConfig,
      'process-one-meeting',
    );
    expect(seams.acquireRuntimeLock).toHaveBeenCalledWith(
      fixture.stateDirectory,
      RUNTIME_FINGERPRINT,
    );
    expect(seams.inspectPreflight).toHaveBeenCalledWith(
      fixture.configPath,
      fixture.runtimeConfig,
    );
    expect(seams.resolveEffectiveConfig).toHaveBeenCalledWith(
      fixture.configPath,
      fixture.runtimeConfig,
    );
    expect(seams.runOneMeeting).toHaveBeenCalledWith({
      database_path: fixture.databasePath,
      binding: {
        organization_id: ORGANIZATION_ID,
        principal_id: PRINCIPAL_ID,
        membership_id: MEMBERSHIP_ID,
        membership_type: 'employee',
        source_adapter_id: 'granola',
        source_instance_id: 'founder-canary',
      },
      source_instance_id: 'founder-canary',
      owner_email: OWNER_EMAIL,
      approved_owner_email_sha256:
        personLoginGrantExpectedEmailSha256(OWNER_EMAIL),
      granola_credential: GRANOLA_CREDENTIAL,
      credential_scope: 'organization',
      credential_reference:
        AUTHORITY_GRANOLA_ORGANIZATION_CREDENTIAL_REFERENCE,
      decision_processor_instance_id: 'founder-structured-text',
    });
    expect(seams.acquireRuntimeLock.mock.invocationCallOrder[0]).toBeLessThan(
      seams.inspectPreflight.mock.invocationCallOrder[0]!,
    );
    expect(seams.inspectPreflight.mock.invocationCallOrder[0]).toBeLessThan(
      seams.runOneMeeting.mock.invocationCallOrder[0]!,
    );
    expect(seams.releaseRuntimeLock).toHaveBeenCalledOnce();
    expect(seams.releaseInitializationLock).toHaveBeenCalledOnce();
  });

  it('refuses an owner file that differs from the active OIDC Person identity', async () => {
    const fixture = createFixture('different@example.com');
    configure(fixture);

    await expect(
      processOneAuthorityMeeting(fixture.configPath, INPUT),
    ).rejects.toThrow(
      'processing source owner email does not match an active approved Person identity',
    );

    expect(seams.runOneMeeting).not.toHaveBeenCalled();
    expect(seams.releaseRuntimeLock).toHaveBeenCalledOnce();
    expect(seams.releaseInitializationLock).toHaveBeenCalledOnce();
  });

  it('stops before preflight and provider wiring when the singleton lock refuses', async () => {
    const fixture = createFixture();
    configure(fixture);
    seams.acquireRuntimeLock.mockRejectedValue(
      new Error(
        'organization authority is already running for this state directory',
      ),
    );

    await expect(
      processOneAuthorityMeeting(fixture.configPath, INPUT),
    ).rejects.toThrow(
      'organization authority is already running for this state directory',
    );

    expect(seams.inspectPreflight).not.toHaveBeenCalled();
    expect(seams.resolveEffectiveConfig).not.toHaveBeenCalled();
    expect(seams.runOneMeeting).not.toHaveBeenCalled();
    expect(seams.releaseRuntimeLock).not.toHaveBeenCalled();
    expect(seams.releaseInitializationLock).toHaveBeenCalledOnce();
  });
});

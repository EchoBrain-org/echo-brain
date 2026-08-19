import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '@echo-brain/organization-api';
import {
  initializeOrganizationControlDatabase,
  inspectOrganizationControlDatabaseForServe,
  inspectOrganizationControlDatabaseReadOnly,
  type OrganizationControlDatabaseIdentity,
} from '@echo-brain/organization-control-plane';
import { organizationMemberReadablePolicyContractSha256 } from '@echo-brain/organization-protocol';
import {
  migrateOrganizationControlDatabaseWithMigrations,
  type OrganizationControlMigration,
} from '../../organization-control-plane/src/persistence/migrate.js';
import {
  inspectAuthorityDatabaseForServe,
  inspectAuthorityDatabaseReadOnly,
} from '../src/adapters/persistence/sqlite/read-only-inspection.js';
import { openAuthorityDatabase } from '../src/adapters/persistence/sqlite/open-database.js';
import { authorityRuntimeFingerprint } from '../src/adapters/runtime/runtime-fingerprint.js';
import {
  acquireAuthorityRuntimeLock,
  authorityRuntimeLockPath,
  inspectAuthorityRuntimeLock,
} from '../src/adapters/runtime/singleton-runtime-lock.js';
import { runOrganizationAuthorityCli } from '../src/composition/cli.js';
import {
  authorityStatePaths,
  readAuthorityRuntimeConfig,
  resolveAuthorityServeConfig,
} from '../src/composition/operator-config.js';
import {
  initializeDevelopmentAuthority,
  installAuthorityIntegrations,
  inspectAuthorityServePreflight,
  inspectInitializedAuthorityState,
  resolveEffectiveAuthorityServeConfig,
  type AuthorityIntegrationsInstallationFaultPoint,
} from '../src/composition/operator-state.js';
import {
  AUTHORITY_PERSON_SESSION_PKCE_KEY_FILENAME,
  AUTHORITY_PERSON_SESSION_RUNTIME_OVERLAY_FILENAME,
} from '../src/composition/person-session-runtime-config.js';
import { startOrganizationAuthority } from '../src/composition/runtime.js';
import { reviewerPolicyContractSha256 } from '../src/application/reviewer-policy-contract.js';
import { PersonIdentitySessionApplication } from '../src/application/person-identity-sessions.js';
import {
  PERSON_SESSION_OIDC_BEGIN_PATH,
  PERSON_SESSION_REFRESH_PATH,
} from '../src/presentation/person-identity-session-http-application.js';
import {
  inspectAuthorityRuntimeOwnership,
  inspectAuthorityStatus,
} from '../src/composition/status.js';

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), 'echo-authority-operator-')),
  );
  temporaryRoots.push(root);
  return root;
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

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

function stateSnapshot(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath =
        prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        result[`${relativePath}/`] = mode(path).toString(8);
        visit(path, relativePath);
      } else {
        result[relativePath] = `${mode(path).toString(8)}:${createHash('sha256')
          .update(readFileSync(path))
          .digest('hex')}`;
      }
    }
  };
  visit(root);
  return result;
}

async function initializedFixture(): Promise<{
  root: string;
  configPath: string;
  stateDirectory: string;
  port: number;
}> {
  const root = temporaryRoot();
  const configPath = join(root, 'authority.json');
  const stateDirectory = join(root, 'state');
  const port = await reserveLoopbackPort();
  await initializeDevelopmentAuthority({
    config_path: configPath,
    state_directory: stateDirectory,
    organization_display_name: 'Example Company',
    port,
  });
  return { root, configPath, stateDirectory, port };
}

function replaceAuthorityDatabaseWithLegacyV2(databasePath: string): void {
  const current = new Database(databasePath, {
    readonly: true,
    fileMustExist: true,
  });
  const metadata = current
    .prepare(
      `SELECT authority_id, organization_id, organization_display_name,
              authority_pin_sha256, descriptor_json, created_at,
              last_observed_at
       FROM authority_metadata WHERE singleton = 1`,
    )
    .get() as {
    authority_id: string;
    organization_id: string;
    organization_display_name: string;
    authority_pin_sha256: string;
    descriptor_json: string;
    created_at: string;
    last_observed_at: string;
  };
  current.close();
  unlinkSync(databasePath);

  const legacy = new Database(databasePath);
  try {
    legacy.exec(
      readFileSync(
        new URL(
          '../migrations/0001_single_org_authority.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    legacy.exec(
      readFileSync(
        new URL(
          '../migrations/0002_admin_command_idempotency.sql',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    legacy
      .prepare(
        `INSERT INTO authority_metadata (
           singleton, authority_id, organization_id,
           organization_display_name, authority_pin_sha256,
           descriptor_json, created_at, last_observed_at
         ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        metadata.authority_id,
        metadata.organization_id,
        metadata.organization_display_name,
        metadata.authority_pin_sha256,
        metadata.descriptor_json,
        metadata.created_at,
        metadata.last_observed_at,
      );
    legacy
      .prepare(
        `INSERT INTO authority_principals (
           principal_id, organization_id, display_name, provisioned_at
         ) VALUES (?, ?, ?, ?)`,
      )
      .run(
        'prn_legacy-preserved',
        metadata.organization_id,
        'Legacy Preserved Employee',
        metadata.created_at,
      );
    legacy
      .prepare(
        `INSERT INTO authority_memberships (
           membership_id, organization_id, principal_id, membership_type,
           status, provisioned_at, revoked_at, revocation_reason,
           admin_command_id, admin_command_sha256
         ) VALUES (?, ?, ?, 'employee', 'active', ?, NULL, NULL, ?, ?)`,
      )
      .run(
        'mem_legacy-preserved',
        metadata.organization_id,
        'prn_legacy-preserved',
        metadata.created_at,
        'adm_00000000-0000-4000-8000-000000000001',
        `sha256:${'a'.repeat(64)}`,
      );
    legacy
      .prepare(
        `INSERT INTO authority_audit_log (
           occurred_at, actor_kind, action, subject_id, detail_json
         ) VALUES (?, 'admin', 'membership.provisioned', ?, '{}')`,
      )
      .run(metadata.created_at, 'mem_legacy-preserved');
    legacy.pragma('user_version = 2');
  } finally {
    legacy.close();
  }
  chmodSync(databasePath, 0o600);
}

function replaceIntegrationsDatabaseWithHistoricalMigrations(
  databasePath: string,
  identity: OrganizationControlDatabaseIdentity,
  migrationFilenames: readonly string[],
): void {
  unlinkSync(databasePath);
  const migrations = migrationFilenames.map((filename, index) => {
    const sql = readFileSync(
      new URL(
        `../../organization-control-plane/migrations/${filename}`,
        import.meta.url,
      ),
      'utf8',
    );
    return {
      version: index + 1,
      filename,
      sql,
      sha256: `sha256:${createHash('sha256').update(sql).digest('hex')}`,
    } satisfies OrganizationControlMigration;
  });
  const legacy = new Database(databasePath);
  try {
    legacy.pragma('foreign_keys = ON');
    migrateOrganizationControlDatabaseWithMigrations(legacy, migrations);
    legacy
      .prepare(
        `INSERT INTO organization_control_plane_metadata (
           singleton, control_plane_id, organization_id, authority_id,
           authority_descriptor_sha256, created_at
         ) VALUES (1, ?, ?, ?, ?, ?)`,
      )
      .run(
        identity.control_plane_id,
        identity.organization_id,
        identity.authority_id,
        identity.authority_descriptor_sha256,
        identity.created_at,
      );
  } finally {
    legacy.close();
  }
  chmodSync(databasePath, 0o600);
}

function replaceIntegrationsDatabaseWithLegacyV1(
  databasePath: string,
  identity: OrganizationControlDatabaseIdentity,
): void {
  replaceIntegrationsDatabaseWithHistoricalMigrations(databasePath, identity, [
    '0001_organization_control_plane.sql',
  ]);
}

function replaceIntegrationsDatabaseWithLegacyV2(
  databasePath: string,
  identity: OrganizationControlDatabaseIdentity,
): void {
  replaceIntegrationsDatabaseWithHistoricalMigrations(databasePath, identity, [
    '0001_organization_control_plane.sql',
    '0002_organization_tool_public_configuration.sql',
  ]);
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('organization authority operator lifecycle', () => {
  it('places runtime ownership in a private directory below the configured shared root', async () => {
    const fixture = await initializedFixture();
    const coordinationRoot = realpathSync(
      mkdtempSync('/tmp/echo-authority-coordination-'),
    );
    temporaryRoots.push(coordinationRoot);
    chmodSync(coordinationRoot, 0o1777);
    const previous = process.env.ECHO_AUTHORITY_COORDINATION_ROOT;
    process.env.ECHO_AUTHORITY_COORDINATION_ROOT = coordinationRoot;
    try {
      const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
      expect(dirname(lockPath)).not.toBe(fixture.stateDirectory);
      expect(dirname(dirname(lockPath))).toBe(coordinationRoot);
      expect(mode(dirname(lockPath))).toBe(0o700);
      const runtimeLock = await acquireAuthorityRuntimeLock(
        fixture.stateDirectory,
        `sha256:${'a'.repeat(64)}`,
      );
      await runtimeLock.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.ECHO_AUTHORITY_COORDINATION_ROOT;
      } else {
        process.env.ECHO_AUTHORITY_COORDINATION_ROOT = previous;
      }
    }
  });

  it('initializes private state once and writes a secret-free strict config last', async () => {
    const fixture = await initializedFixture();
    const firstConfig = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const adminToken = readFileSync(paths.admin_credential_path, 'utf8');
    const proxyToken = readFileSync(paths.proxy_credential_path, 'utf8');
    const configText = readFileSync(fixture.configPath, 'utf8');
    const manifestText = readFileSync(
      paths.initialization_manifest_path,
      'utf8',
    );
    const manifest = JSON.parse(manifestText) as {
      config_path: string;
      runtime_config: unknown;
    };

    expect(mode(fixture.configPath)).toBe(0o600);
    expect(mode(paths.state_directory)).toBe(0o700);
    expect(mode(paths.key_directory)).toBe(0o700);
    expect(mode(paths.credential_directory)).toBe(0o700);
    expect(mode(paths.admin_credential_path)).toBe(0o600);
    expect(mode(paths.proxy_credential_path)).toBe(0o600);
    expect(mode(paths.database_path)).toBe(0o600);
    expect(mode(paths.integrations_database_path)).toBe(0o600);
    expect(mode(paths.integrations_installation_marker_path)).toBe(0o600);
    expect(mode(paths.identity_path)).toBe(0o600);
    expect(mode(paths.initialization_manifest_path)).toBe(0o600);
    expect(manifest.config_path).toBe(fixture.configPath);
    expect(manifest.runtime_config).toEqual(firstConfig);
    expect(adminToken).not.toBe(proxyToken);
    expect(configText).not.toContain(adminToken);
    expect(configText).not.toContain(proxyToken);
    expect(manifestText).not.toContain(adminToken);
    expect(manifestText).not.toContain(proxyToken);

    const database = inspectAuthorityDatabaseReadOnly(paths.database_path);
    expect(database.tables).toEqual([
      'authority_access_lease_requests',
      'authority_access_states',
      'authority_audit_log',
      'authority_enrollment_grants',
      'authority_enrollments',
      'authority_internal_live_releases',
      'authority_internal_live_update_receipts',
      'authority_member_exclusion_read_audit',
      'authority_memberships',
      'authority_metadata',
      'authority_oidc_identity_bindings',
      'authority_oidc_login_attempts',
      'authority_organization_member_recording_activation',
      'authority_person_login_grants',
      'authority_person_read_decision_audit',
      'authority_person_session_credentials',
      'authority_person_session_families',
      'authority_principals',
      'authority_processing_candidates',
      'authority_processing_delivery_receipts',
      'authority_processing_member_exclusions',
      'authority_processing_processed_markers',
      'authority_processing_resolutions',
      'authority_processing_slots',
      'authority_processing_source_cursors',
      'authority_processing_source_owner_bindings',
      'authority_query_decision_audit',
      'authority_readable_search_active_generation',
      'authority_readable_search_query_audit',
    ]);
    expect(database.authority_id).toBe(firstConfig.authority.authority_id);
    expect(database.organization_id).toBe(
      firstConfig.organization.organization_id,
    );
    const integrations = inspectOrganizationControlDatabaseReadOnly(
      paths.integrations_database_path,
    );
    expect(integrations).toMatchObject({
      organization_id: firstConfig.organization.organization_id,
      authority_id: firstConfig.authority.authority_id,
      authority_descriptor_sha256: firstConfig.authority.authority_pin_sha256,
    });
    expect(database).toMatchObject({
      integrations_control_plane_id: integrations.control_plane_id,
      integrations_marker_sha256: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      ),
      integrations_installed_at: expect.any(String),
    });
    expect(
      JSON.parse(
        readFileSync(paths.integrations_installation_marker_path, 'utf8'),
      ),
    ).toMatchObject({
      schema_version: 1,
      kind: 'echo-organization-authority-integrations-installation-marker',
      control_plane_id: integrations.control_plane_id,
      organization_id: integrations.organization_id,
      authority_id: integrations.authority_id,
      authority_descriptor_sha256: integrations.authority_descriptor_sha256,
      integrations_database_path: paths.integrations_database_path,
      database_created_at: integrations.created_at,
    });

    const repeated = await initializeDevelopmentAuthority({
      config_path: fixture.configPath,
      state_directory: fixture.stateDirectory,
      organization_display_name: 'Example Company',
      port: fixture.port,
    });
    expect(repeated.created).toBe(false);
    expect(repeated.authority_descriptor.authority_id).toBe(
      firstConfig.authority.authority_id,
    );
  });

  it('keeps current-schema read-only inspection fail-closed on extra tables', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    const database = new Database(paths.database_path);
    try {
      database.exec('CREATE TABLE unexpected_authority_state (value TEXT)');
    } finally {
      database.close();
    }

    expect(() =>
      inspectAuthorityDatabaseReadOnly(paths.database_path),
    ).toThrow('organization authority database table set is invalid');
  });

  it('folds the opt-in Person overlay without rewriting initialized intent', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const configBytes = readFileSync(fixture.configPath);
    const manifestBytes = readFileSync(paths.initialization_manifest_path);
    const keyPath = join(
      paths.credential_directory,
      AUTHORITY_PERSON_SESSION_PKCE_KEY_FILENAME,
    );
    const overlayPath = join(
      paths.state_directory,
      AUTHORITY_PERSON_SESSION_RUNTIME_OVERLAY_FILENAME,
    );
    writeFileSync(keyPath, Buffer.alloc(32, 6).toString('base64url'), {
      mode: 0o600,
    });
    chmodSync(keyPath, 0o600);
    writeFileSync(
      overlayPath,
      `${JSON.stringify({
        schema_version: 1,
        kind: 'echo-organization-authority-person-session-runtime-overlay',
        authority_id: config.authority.authority_id,
        organization_id: config.organization.organization_id,
        oidc: {
          issuer: 'https://identity.example/tenant',
          client_id: 'echo-person-client',
          redirect_uri:
            'https://authority.example/v2/session/oidc/callback',
          tenant: { kind: 'issuer' },
          id_token_algorithms: ['RS256'],
          client_authentication: { method: 'none' },
        },
        pkce_sealing_key_ref: `file:${keyPath}`,
      })}\n`,
      { mode: 0o600 },
    );
    chmodSync(overlayPath, 0o600);

    const baseline = authorityRuntimeFingerprint(
      resolveAuthorityServeConfig(config),
    );
    const first = resolveEffectiveAuthorityServeConfig(
      fixture.configPath,
      config,
    );
    const firstFingerprint = authorityRuntimeFingerprint(first);
    expect(first.person_session_runtime_v1).toBeDefined();
    expect(firstFingerprint).not.toBe(baseline);
    expect(readFileSync(fixture.configPath)).toEqual(configBytes);
    expect(readFileSync(paths.initialization_manifest_path)).toEqual(
      manifestBytes,
    );

    writeFileSync(keyPath, Buffer.alloc(32, 7).toString('base64url'));
    const rotated = resolveEffectiveAuthorityServeConfig(
      fixture.configPath,
      config,
    );
    expect(authorityRuntimeFingerprint(rotated)).not.toBe(firstFingerprint);
  });

  it('starts a slashless-root Person issuer offline and expires attempts', async () => {
    const fixture = await initializedFixture();
    const base = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const configured = {
      ...base,
      person_session_runtime_v1: Object.freeze({
        overlay_sha256: `sha256:${'a'.repeat(64)}` as const,
        oidc_configuration: Object.freeze({
          issuer: 'https://accounts.google.com',
          client_id: 'echo-person-client',
          redirect_uri:
            'https://authority.example/v2/session/oidc/callback',
          tenant: Object.freeze({ kind: 'issuer' as const }),
          id_token_algorithms: Object.freeze(['RS256']),
        }),
        client_authentication: Object.freeze({ method: 'none' as const }),
        pkce_sealing_key: new Uint8Array(32).fill(7),
      }),
    };
    const expire = vi.spyOn(
      PersonIdentitySessionApplication.prototype,
      'expireOidcLoginAttempts',
    );
    const begin = vi.spyOn(
      PersonIdentitySessionApplication.prototype,
      'beginOidcLogin',
    );
    let discoveryCalls = 0;
    let runtime: Awaited<ReturnType<typeof startOrganizationAuthority>> | undefined;
    try {
      runtime = await startOrganizationAuthority(configured, {
        discoverPersonSessionOidcProvider: async () => {
          discoveryCalls += 1;
          if (discoveryCalls === 1) {
            throw new Error('identity provider is temporarily unavailable');
          }
          return {
            buildAuthorizationUrl: (attempt) =>
              `https://identity.example/authorize?state=${encodeURIComponent(attempt.state)}`,
            redeemAuthorizationCode: async () =>
              ({ kind: 'terminal_failure' }) as const,
          };
        },
      });
      expect(discoveryCalls).toBe(0);
      expect(expire).toHaveBeenCalledTimes(1);
      expect(expire).toHaveBeenLastCalledWith({ limit: 1000 });

      const origin = `http://127.0.0.1:${String(runtime.address.port)}`;
      const proxyHeaders = {
        [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
          `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${configured.trusted_proxy_token}`,
        [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
          .update('offline-person-session-runtime-test')
          .digest('base64url')}`,
        'content-type': 'application/json',
      };
      const refresh = await fetch(`${origin}${PERSON_SESSION_REFRESH_PATH}`, {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify({ refresh_token: 'R'.repeat(43) }),
      });
      expect(refresh.status).toBe(401);
      expect(discoveryCalls).toBe(0);
      expect(expire).toHaveBeenCalledTimes(1);

      const unavailable = await fetch(
        `${origin}${PERSON_SESSION_OIDC_BEGIN_PATH}`,
        {
          method: 'POST',
          headers: proxyHeaders,
          body: JSON.stringify({ kind: 'existing_identity_login' }),
        },
      );
      expect(unavailable.status).toBe(503);
      expect(discoveryCalls).toBe(1);
      expect(expire).toHaveBeenCalledTimes(2);
      expect(begin).not.toHaveBeenCalled();

      const begun = await fetch(`${origin}${PERSON_SESSION_OIDC_BEGIN_PATH}`, {
        method: 'POST',
        headers: proxyHeaders,
        body: JSON.stringify({ kind: 'existing_identity_login' }),
      });
      expect(begun.status).toBe(201);
      expect(discoveryCalls).toBe(2);
      expect(expire).toHaveBeenCalledTimes(3);
      expect(expire).toHaveBeenLastCalledWith({ limit: 1000 });
      expect(begin).toHaveBeenCalledTimes(1);
    } finally {
      await runtime?.close();
      expire.mockRestore();
      begin.mockRestore();
    }
  });

  it('serializes concurrent initialization and safely completes a published state without config', async () => {
    const root = temporaryRoot();
    const configPath = join(root, 'authority.json');
    const stateDirectory = join(root, 'state');
    const port = await reserveLoopbackPort();
    const initialize = () =>
      initializeDevelopmentAuthority({
        config_path: configPath,
        state_directory: stateDirectory,
        organization_display_name: 'Example Company',
        port,
      });

    const concurrent = await Promise.allSettled([initialize(), initialize()]);
    expect(
      concurrent.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      concurrent.filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
    const original = readAuthorityRuntimeConfig(configPath);
    await inspectInitializedAuthorityState(configPath, original);

    unlinkSync(configPath);
    const differentConfigPath = join(root, 'different-authority.json');
    await expect(
      initializeDevelopmentAuthority({
        config_path: differentConfigPath,
        state_directory: stateDirectory,
        organization_display_name: 'Example Company',
        port,
      }),
    ).rejects.toThrow('differs from the requested initialization');
    await expect(
      initializeDevelopmentAuthority({
        config_path: configPath,
        state_directory: stateDirectory,
        organization_display_name: 'Different Company',
        port,
      }),
    ).rejects.toThrow('differs from the requested initialization');
    const differentPort = port === 65_535 ? port - 1 : port + 1;
    await expect(
      initializeDevelopmentAuthority({
        config_path: configPath,
        state_directory: stateDirectory,
        organization_display_name: 'Example Company',
        port: differentPort,
      }),
    ).rejects.toThrow('differs from the requested initialization');
    expect(existsSync(differentConfigPath)).toBe(false);
    expect(existsSync(configPath)).toBe(false);

    const recovered = await initialize();
    expect(recovered).toMatchObject({
      created: false,
      authority_descriptor: { authority_id: original.authority.authority_id },
    });
    expect(readAuthorityRuntimeConfig(configPath)).toEqual(original);
  });

  it('rejects copied or altered configs that are not the initialized intent', async () => {
    const fixture = await initializedFixture();
    const original = readAuthorityRuntimeConfig(fixture.configPath);
    const copiedConfigPath = join(fixture.root, 'copied-authority.json');
    writeFileSync(copiedConfigPath, readFileSync(fixture.configPath), {
      flag: 'wx',
      mode: 0o600,
    });

    const copiedStatus = await inspectAuthorityStatus(copiedConfigPath);
    expect(copiedStatus).toMatchObject({
      ok: false,
      initialized: false,
    });
    expect(copiedStatus.checks.at(-1)?.detail).toContain(
      'differ from the initialized intent',
    );
    await expect(
      inspectAuthorityRuntimeOwnership(copiedConfigPath),
    ).resolves.toMatchObject({ ok: false, initialized: false });
    await expect(
      inspectAuthorityServePreflight(copiedConfigPath, original),
    ).rejects.toThrow('differ from the initialized intent');
    await expect(
      runOrganizationAuthorityCli(
        ['serve', '--config', copiedConfigPath],
        {},
        { stdout: () => {}, stderr: () => {} },
      ),
    ).rejects.toThrow('differ from the initialized intent');

    const altered = {
      ...original,
      listener: {
        ...original.listener,
        port:
          original.listener.port === 65_535
            ? original.listener.port - 1
            : original.listener.port + 1,
      },
    };
    writeFileSync(
      fixture.configPath,
      `${JSON.stringify(altered, null, 2)}\n`,
      'utf8',
    );
    const alteredConfig = readAuthorityRuntimeConfig(fixture.configPath);
    const alteredStatus = await inspectAuthorityStatus(fixture.configPath);
    expect(alteredStatus).toMatchObject({
      ok: false,
      initialized: false,
    });
    expect(alteredStatus.checks.at(-1)?.detail).toContain(
      'differ from the initialized intent',
    );
    await expect(
      inspectAuthorityServePreflight(fixture.configPath, alteredConfig),
    ).rejects.toThrow('differ from the initialized intent');
  });

  it('requires a strict private initialization manifest on repeated init', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    chmodSync(paths.initialization_manifest_path, 0o644);
    const insecureStatus = await inspectAuthorityStatus(fixture.configPath);
    expect(insecureStatus).toMatchObject({ ok: false, initialized: false });
    expect(insecureStatus.checks.at(-1)?.detail).toContain('0600');
    chmodSync(paths.initialization_manifest_path, 0o600);

    const manifest = JSON.parse(
      readFileSync(paths.initialization_manifest_path, 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      paths.initialization_manifest_path,
      `${JSON.stringify({ ...manifest, unexpected: true })}\n`,
      'utf8',
    );

    await expect(
      initializeDevelopmentAuthority({
        config_path: fixture.configPath,
        state_directory: fixture.stateDirectory,
        organization_display_name: 'Example Company',
        port: fixture.port,
      }),
    ).rejects.toThrow('unsupported shape');
    const status = await inspectAuthorityStatus(fixture.configPath);
    expect(status).toMatchObject({ ok: false, initialized: false });
    expect(status.checks.at(-1)?.detail).toContain('unsupported shape');
  });

  it('reports cleanly stopped state without mutating authority files', async () => {
    const fixture = await initializedFixture();
    const before = stateSnapshot(fixture.root);
    const report = await inspectAuthorityStatus(fixture.configPath);
    const after = stateSnapshot(fixture.root);

    expect(report).toMatchObject({
      ok: true,
      initialized: true,
      running: false,
      healthy: false,
    });
    expect(after).toEqual(before);
  });

  it('can prove runtime ownership inputs without opening SQLite', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    writeFileSync(paths.database_path, 'not a SQLite database', 'utf8');

    await expect(
      inspectAuthorityRuntimeOwnership(fixture.configPath),
    ).resolves.toMatchObject({
      ok: true,
      initialized: true,
      running: false,
      healthy: false,
    });
    await expect(
      inspectAuthorityStatus(fixture.configPath),
    ).resolves.toMatchObject({
      ok: false,
      initialized: false,
    });
  });

  it('does not contact an unrelated listener while no runtime owner exists', async () => {
    const fixture = await initializedFixture();
    let requests = 0;
    const hostile = createHttpServer((_request, response) => {
      requests += 1;
      response.writeHead(200).end('unexpected');
    });
    await new Promise<void>((resolve, reject) => {
      hostile.once('error', reject);
      hostile.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: true,
        running: false,
        healthy: false,
      });
      expect(requests).toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => {
        hostile.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('rejects a lookalike owned listener without sending authority credentials', async () => {
    const fixture = await initializedFixture();
    const runtimeConfig = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      authorityRuntimeFingerprint(runtimeConfig),
    );
    const observedHeaders: Array<
      Record<string, string | string[] | undefined>
    > = [];
    const listener = createHttpServer((request, response) => {
      observedHeaders.push(request.headers);
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          error: {
            code: 'proxy_identity_unavailable',
            message: 'trusted proxy identity is unavailable',
          },
        }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: false,
        running: true,
        healthy: false,
      });
      expect(observedHeaders).toHaveLength(1);
      expect(
        observedHeaders[0]?.['x-echo-proxy-authorization'],
      ).toBeUndefined();
      expect(
        observedHeaders[0]?.['x-echo-authenticated-client-id'],
      ).toBeUndefined();
    } finally {
      await runtimeLock.release();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('rejects runtime ownership composed from different policy', async () => {
    const fixture = await initializedFixture();
    const canonical = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const alternateFingerprint = authorityRuntimeFingerprint({
      ...canonical,
      active_lease_ttl_ms: canonical.active_lease_ttl_ms - 1,
    });
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      alternateFingerprint,
    );
    try {
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: false,
        initialized: true,
        running: true,
        healthy: false,
      });
      expect(report.checks.at(-1)?.detail).toContain(
        'does not match the configured files or policy',
      );
    } finally {
      await runtimeLock.release();
    }
  });

  it('serves the pinned identity, reports healthy, and rejects a second owner', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    await inspectInitializedAuthorityState(fixture.configPath, config);
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtime = await startOrganizationAuthority(serveConfig);
    try {
      const lock = JSON.parse(
        readFileSync(authorityRuntimeLockPath(fixture.stateDirectory), 'utf8'),
      ) as { schema_version: number; guard_socket: string };
      expect(lock.schema_version).toBe(2);
      expect(
        statSync(join(fixture.stateDirectory, lock.guard_socket)).isSocket(),
      ).toBe(true);
      await expect(startOrganizationAuthority(serveConfig)).rejects.toThrow(
        'already running for this state directory',
      );
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(report).toMatchObject({
        ok: true,
        initialized: true,
        running: true,
        healthy: true,
        authority_id: config.authority.authority_id,
        organization_id: config.organization.organization_id,
      });
    } finally {
      await runtime.close();
    }
    const stopped = await inspectAuthorityStatus(fixture.configPath);
    expect(stopped, JSON.stringify(stopped)).toMatchObject({
      ok: true,
      running: false,
    });
    expect(
      readdirSync(fixture.stateDirectory).some((name) =>
        name.startsWith('.g-'),
      ),
    ).toBe(false);
  });

  it('abandons kernel ownership but preserves recovery state when shutdown fails', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    const runtimeModule = new URL(
      '../dist/composition/runtime.js',
      import.meta.url,
    ).href;
    const configModule = new URL(
      '../dist/composition/operator-config.js',
      import.meta.url,
    ).href;
    const applicationModule = new URL(
      '../dist/application/organization-authority.js',
      import.meta.url,
    ).href;
    const lockModule = new URL(
      '../dist/adapters/runtime/singleton-runtime-lock.js',
      import.meta.url,
    ).href;
    const childOutput = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const [{ startOrganizationAuthority }, { readAuthorityRuntimeConfig, resolveAuthorityServeConfig }, { OrganizationAuthorityApplication }, { inspectAuthorityRuntimeLock }] = await Promise.all([
          import(${JSON.stringify(runtimeModule)}),
          import(${JSON.stringify(configModule)}),
          import(${JSON.stringify(applicationModule)}),
          import(${JSON.stringify(lockModule)})
        ]);
        const config = readAuthorityRuntimeConfig(process.env.ECHO_TEST_AUTHORITY_CONFIG);
        const serveConfig = resolveAuthorityServeConfig(config);
        const runtime = await startOrganizationAuthority(serveConfig);
        OrganizationAuthorityApplication.prototype.close = function () {
          throw new Error('injected application shutdown failure');
        };
        let failure = null;
        try { await runtime.close(); }
        catch (error) { failure = error instanceof Error ? error.message : String(error); }
        const inspection = await inspectAuthorityRuntimeLock(config.state_dir);
        process.stdout.write(JSON.stringify({ failure, inspection }));`,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          ECHO_TEST_AUTHORITY_CONFIG: fixture.configPath,
        },
        timeout: 15_000,
      },
    );
    const childResult = JSON.parse(childOutput) as {
      failure: string | null;
      inspection: { present: boolean; active: boolean };
    };
    expect(childResult.failure).toContain(
      'injected application shutdown failure',
    );
    expect(childResult.inspection).toMatchObject({
      present: true,
      active: true,
    });

    expect(
      await inspectAuthorityRuntimeLock(fixture.stateDirectory),
    ).toMatchObject({
      present: true,
      active: false,
    });
    const recovered = await startOrganizationAuthority(serveConfig);
    await recovered.close();
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
  });

  it('recovers a stale runtime lock even when its pid has been reused', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_socket: `.g-${'a'.repeat(6)}`,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const serveConfig = resolveAuthorityServeConfig(config);
    const contenders = await Promise.allSettled([
      startOrganizationAuthority(serveConfig),
      startOrganizationAuthority(serveConfig),
    ]);
    expect(
      contenders.filter(({ status }) => status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      contenders.filter(({ status }) => status === 'rejected'),
    ).toHaveLength(1);
    const winner = contenders.find(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof startOrganizationAuthority>>
      > => result.status === 'fulfilled',
    );
    if (winner === undefined)
      throw new Error('stale-lock recovery had no owner');
    const runtime = winner.value;
    try {
      expect((await inspectAuthorityStatus(fixture.configPath)).healthy).toBe(
        true,
      );
    } finally {
      await runtime.close();
    }
    expect(existsSync(lockPath)).toBe(false);
    expect(
      readdirSync(fixture.stateDirectory).some((name) =>
        name.includes('.prepare-'),
      ),
    ).toBe(false);
  });

  it('upgrades a proven-stale schema-1 TCP ownership lock', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const stalePort = await reserveLoopbackPort();
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_port: stalePort,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );

    const lock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      `sha256:${'c'.repeat(64)}`,
    );
    try {
      const upgraded = JSON.parse(readFileSync(lockPath, 'utf8')) as {
        schema_version: number;
      };
      expect(upgraded.schema_version).toBe(2);
    } finally {
      await lock.release();
    }
  });

  it('authenticates and preserves a live schema-1 TCP ownership lock', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const token = 'a'.repeat(64);
    const legacyGuard = createNetServer((socket) => {
      socket.once('data', (bytes) => {
        const line = bytes.toString('ascii').trimEnd();
        const nonce = line.slice(line.lastIndexOf(' ') + 1);
        const proof = createHmac('sha256', Buffer.from(token, 'hex'))
          .update('echo-organization-authority-kernel-guard-v1\0', 'utf8')
          .update(nonce, 'ascii')
          .digest('hex');
        socket.end(
          `echo-organization-authority-guard/1 proof ${proof}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      legacyGuard.once('error', reject);
      legacyGuard.listen(0, '127.0.0.1', resolve);
    });
    const address = legacyGuard.address();
    if (address === null || typeof address === 'string') {
      throw new Error('legacy guard did not bind TCP');
    }
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 1,
        pid: process.pid,
        token,
        guard_port: address.port,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const original = readFileSync(lockPath, 'utf8');
    try {
      await expect(
        acquireAuthorityRuntimeLock(
          fixture.stateDirectory,
          `sha256:${'c'.repeat(64)}`,
        ),
      ).rejects.toThrow('authenticated kernel ownership guard is active');
      expect(readFileSync(lockPath, 'utf8')).toBe(original);
    } finally {
      await new Promise<void>((resolve, reject) => {
        legacyGuard.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('fails closed on a wrong guard proof without replacing ownership state', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const guardSocket = `.g-${'a'.repeat(6)}`;
    const guardPath = join(fixture.stateDirectory, guardSocket);
    let challenges = 0;
    const unrelated = createNetServer((socket) => {
      socket.once('data', () => {
        challenges += 1;
        socket.end(
          `echo-organization-authority-guard/1 proof ${'0'.repeat(64)}\n`,
        );
      });
    });
    await new Promise<void>((resolve, reject) => {
      unrelated.once('error', reject);
      unrelated.listen(guardPath, resolve);
    });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_socket: guardSocket,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const originalLock = readFileSync(lockPath, 'utf8');

    try {
      await expect(
        inspectAuthorityRuntimeLock(fixture.stateDirectory),
      ).rejects.toThrow('could not be authenticated safely');

      const config = readAuthorityRuntimeConfig(fixture.configPath);
      const serveConfig = resolveAuthorityServeConfig(config);
      const contenders = await Promise.allSettled([
        startOrganizationAuthority(serveConfig),
        startOrganizationAuthority(serveConfig),
      ]);
      expect(
        contenders.filter(({ status }) => status === 'rejected'),
      ).toHaveLength(2);
      expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
      expect(challenges).toBeGreaterThanOrEqual(3);
    } finally {
      await new Promise<void>((resolve, reject) => {
        unrelated.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('fails closed when a guard accepts a challenge but gives no answer', async () => {
    const fixture = await initializedFixture();
    const lockPath = authorityRuntimeLockPath(fixture.stateDirectory);
    const guardSocket = `.g-${'a'.repeat(6)}`;
    const guardPath = join(fixture.stateDirectory, guardSocket);
    const sockets = new Set<Socket>();
    const silent = createNetServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('data', () => undefined);
    });
    await new Promise<void>((resolve, reject) => {
      silent.once('error', reject);
      silent.listen(guardPath, resolve);
    });
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        schema_version: 2,
        pid: process.pid,
        token: 'a'.repeat(64),
        guard_socket: guardSocket,
        runtime_fingerprint_sha256: `sha256:${'b'.repeat(64)}`,
      })}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    const originalLock = readFileSync(lockPath, 'utf8');

    try {
      const config = readAuthorityRuntimeConfig(fixture.configPath);
      await expect(
        startOrganizationAuthority(resolveAuthorityServeConfig(config)),
      ).rejects.toThrow('could not be authenticated safely');
      expect(readFileSync(lockPath, 'utf8')).toBe(originalLock);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        silent.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('never recreates a missing initialized database while serving', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    unlinkSync(config.database_path);

    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow();
    expect(existsSync(config.database_path)).toBe(false);
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
  });

  it('never recreates installed integration state when both sibling files are lost', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    unlinkSync(paths.integrations_database_path);
    unlinkSync(paths.integrations_installation_marker_path);

    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow();
    await expect(
      inspectAuthorityStatus(fixture.configPath),
    ).resolves.toMatchObject({ ok: false, initialized: false });
    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow();
    expect(existsSync(paths.integrations_database_path)).toBe(false);
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);

    await expect(
      installAuthorityIntegrations(fixture.configPath),
    ).rejects.toThrow(
      'previously installed but the database or marker is missing',
    );
    expect(existsSync(paths.integrations_database_path)).toBe(false);
    expect(existsSync(paths.integrations_installation_marker_path)).toBe(false);
  });

  it('installs integration state once for a verified legacy authority', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    replaceAuthorityDatabaseWithLegacyV2(config.database_path);
    unlinkSync(paths.integrations_database_path);
    unlinkSync(paths.integrations_installation_marker_path);

    const output: string[] = [];
    expect(
      await runOrganizationAuthorityCli(
        ['install-integrations', '--config', fixture.configPath],
        {},
        {
          stdout: (value) => output.push(value),
          stderr: () => {},
        },
      ),
    ).toBe(0);
    const installed = JSON.parse(output.shift()!) as {
      created: boolean;
      control_plane_id: string;
    };
    expect(installed.created).toBe(true);
    expect(existsSync(paths.integrations_database_path)).toBe(true);
    expect(existsSync(paths.integrations_installation_marker_path)).toBe(true);
    const marker = JSON.parse(
      readFileSync(paths.integrations_installation_marker_path, 'utf8'),
    ) as { control_plane_id: string };
    expect(marker.control_plane_id).toBe(installed.control_plane_id);
    const upgradedAuthority = new Database(config.database_path, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      expect(
        upgradedAuthority
          .prepare(
            `SELECT membership_id, principal_id, status
             FROM authority_memberships`,
          )
          .get(),
      ).toEqual({
        membership_id: 'mem_legacy-preserved',
        principal_id: 'prn_legacy-preserved',
        status: 'active',
      });
      expect(
        upgradedAuthority
          .prepare(
            `SELECT action, subject_id FROM authority_audit_log`,
          )
          .get(),
      ).toEqual({
        action: 'membership.provisioned',
        subject_id: 'mem_legacy-preserved',
      });
    } finally {
      upgradedAuthority.close();
    }

    const repeated = await installAuthorityIntegrations(fixture.configPath);
    expect(repeated).toMatchObject({
      created: false,
      control_plane_id: installed.control_plane_id,
      organization_id: config.organization.organization_id,
      authority_id: config.authority.authority_id,
    });

    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(config),
    );
    await runtime.close();
  });

  it('migrates and anchors a valid legacy v1 integrations pair', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const integrationsIdentity =
      inspectOrganizationControlDatabaseReadOnly(
        paths.integrations_database_path,
      );
    replaceAuthorityDatabaseWithLegacyV2(config.database_path);
    replaceIntegrationsDatabaseWithLegacyV1(
      paths.integrations_database_path,
      integrationsIdentity,
    );

    const installed = await installAuthorityIntegrations(fixture.configPath);

    expect(installed).toMatchObject({
      created: false,
      control_plane_id: integrationsIdentity.control_plane_id,
    });
    expect(
      inspectOrganizationControlDatabaseReadOnly(
        paths.integrations_database_path,
      ),
    ).toMatchObject({
      schema_version: 5,
      control_plane_id: integrationsIdentity.control_plane_id,
    });
    expect(
      inspectAuthorityDatabaseReadOnly(config.database_path),
    ).toMatchObject({
      schema_version: 14,
      integrations_control_plane_id: integrationsIdentity.control_plane_id,
      integrations_marker_sha256: expect.stringMatching(
        /^sha256:[0-9a-f]{64}$/,
      ),
    });
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(config),
    );
    await runtime.close();
  });

  it('accepts an anchored v2 database read-only before runtime migration', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const integrationsIdentity =
      inspectOrganizationControlDatabaseReadOnly(
        paths.integrations_database_path,
      );
    replaceIntegrationsDatabaseWithLegacyV2(
      paths.integrations_database_path,
      integrationsIdentity,
    );
    const beforeMaintenance = stateSnapshot(fixture.root);

    const installed = await installAuthorityIntegrations(fixture.configPath);

    expect(stateSnapshot(fixture.root)).toEqual(beforeMaintenance);
    expect(installed).toMatchObject({
      created: false,
      control_plane_id: integrationsIdentity.control_plane_id,
    });
    expect(
      inspectOrganizationControlDatabaseForServe(
        paths.integrations_database_path,
      ),
    ).toMatchObject({
      schema_version: 2,
      control_plane_id: integrationsIdentity.control_plane_id,
    });
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(config),
    );
    await runtime.close();
    expect(
      inspectOrganizationControlDatabaseReadOnly(
        paths.integrations_database_path,
      ),
    ).toMatchObject({
      schema_version: 5,
      control_plane_id: integrationsIdentity.control_plane_id,
    });
  });

  it.each(
    [
      ['after_authority_migration', false, false, false, true],
      ['after_database_published', true, false, false, false],
      ['after_marker_published', true, true, false, false],
      ['after_anchor_committed', true, true, true, false],
    ] as const,
  )(
    'resumes install-integrations after fault point %s',
    async (
      faultPoint,
      databaseAfterFault,
      markerAfterFault,
      anchoredAfterFault,
      retryCreated,
    ) => {
      const fixture = await initializedFixture();
      const config = readAuthorityRuntimeConfig(fixture.configPath);
      const paths = authorityStatePaths(fixture.stateDirectory);
      replaceAuthorityDatabaseWithLegacyV2(config.database_path);
      unlinkSync(paths.integrations_database_path);
      unlinkSync(paths.integrations_installation_marker_path);

      await expect(
        installAuthorityIntegrations(fixture.configPath, {
          faultInjector: (
            observed: AuthorityIntegrationsInstallationFaultPoint,
          ) => {
            if (observed === faultPoint) throw new Error(`fault:${faultPoint}`);
          },
        }),
      ).rejects.toThrow(`fault:${faultPoint}`);

      const interruptedAuthority = inspectAuthorityDatabaseReadOnly(
        config.database_path,
      );
      expect(interruptedAuthority.schema_version).toBe(14);
      expect(
        interruptedAuthority.integrations_control_plane_id !== null,
      ).toBe(anchoredAfterFault);
      expect(existsSync(paths.integrations_database_path)).toBe(
        databaseAfterFault,
      );
      expect(existsSync(paths.integrations_installation_marker_path)).toBe(
        markerAfterFault,
      );

      const recovered = await installAuthorityIntegrations(fixture.configPath);
      expect(recovered.created).toBe(retryCreated);
      const recoveredAuthority = inspectAuthorityDatabaseReadOnly(
        config.database_path,
      );
      expect(recoveredAuthority).toMatchObject({
        schema_version: 14,
        integrations_control_plane_id: recovered.control_plane_id,
        integrations_marker_sha256: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/,
        ),
        integrations_installed_at: expect.any(String),
      });
      expect(
        inspectOrganizationControlDatabaseReadOnly(
          paths.integrations_database_path,
        ).control_plane_id,
      ).toBe(recovered.control_plane_id);
      expect(existsSync(paths.integrations_installation_marker_path)).toBe(true);
      expect(
        readdirSync(paths.state_directory).filter((name) =>
          name.includes('.installing-'),
        ),
      ).toEqual([]);

      const repeated = await installAuthorityIntegrations(fixture.configPath);
      expect(repeated).toMatchObject({
        created: false,
        control_plane_id: recovered.control_plane_id,
      });
      const runtime = await startOrganizationAuthority(
        resolveAuthorityServeConfig(config),
      );
      await runtime.close();
    },
  );

  it('restarts a valid marker-only publication only for an exact current unanchored authority', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const abandonedMarker = JSON.parse(
      readFileSync(paths.integrations_installation_marker_path, 'utf8'),
    ) as { control_plane_id: string };
    replaceAuthorityDatabaseWithLegacyV2(config.database_path);
    unlinkSync(paths.integrations_database_path);
    openAuthorityDatabase(config.database_path, {
      fileMustExist: true,
    }).close();

    const recovered = await installAuthorityIntegrations(fixture.configPath);
    expect(recovered.created).toBe(true);
    expect(recovered.control_plane_id).not.toBe(
      abandonedMarker.control_plane_id,
    );
    expect(
      inspectAuthorityDatabaseReadOnly(config.database_path),
    ).toMatchObject({
      integrations_control_plane_id: recovered.control_plane_id,
    });
  });

  it('refuses to adopt a foreign database-only publication in the current unanchored state', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    replaceAuthorityDatabaseWithLegacyV2(config.database_path);
    unlinkSync(paths.integrations_database_path);
    unlinkSync(paths.integrations_installation_marker_path);
    openAuthorityDatabase(config.database_path, {
      fileMustExist: true,
    }).close();
    const foreign = initializeOrganizationControlDatabase(
      paths.integrations_database_path,
      {
        organization_id: 'org_different',
        authority_id: config.authority.authority_id,
        authority_descriptor_sha256: config.authority.authority_pin_sha256,
        created_at: new Date().toISOString(),
      },
    );

    await expect(
      installAuthorityIntegrations(fixture.configPath),
    ).rejects.toThrow(
      'organization integrations database identity differs from config',
    );
    expect(
      inspectAuthorityDatabaseReadOnly(config.database_path),
    ).toMatchObject({
      integrations_control_plane_id: null,
      integrations_marker_sha256: null,
      integrations_installed_at: null,
    });
    expect(
      inspectOrganizationControlDatabaseReadOnly(
        paths.integrations_database_path,
      ).control_plane_id,
    ).toBe(foreign.control_plane_id);
    expect(existsSync(paths.integrations_installation_marker_path)).toBe(false);
  });

  it('still refuses a partial integrations pair while the authority is legacy', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    replaceAuthorityDatabaseWithLegacyV2(config.database_path);
    unlinkSync(paths.integrations_installation_marker_path);

    await expect(
      installAuthorityIntegrations(fixture.configPath),
    ).rejects.toThrow(
      'legacy authority has only part of the integrations database-marker pair',
    );
    expect(
      inspectAuthorityDatabaseForServe(config.database_path),
    ).toMatchObject({ schema_version: 2 });
    expect(existsSync(paths.integrations_database_path)).toBe(true);
    expect(existsSync(paths.integrations_installation_marker_path)).toBe(false);
  });

  it('refuses to adopt an integration database whose immutable marker is missing', async () => {
    const fixture = await initializedFixture();
    const paths = authorityStatePaths(fixture.stateDirectory);
    unlinkSync(paths.integrations_installation_marker_path);

    await expect(
      installAuthorityIntegrations(fixture.configPath),
    ).rejects.toThrow('database or marker is missing');
    expect(existsSync(paths.integrations_database_path)).toBe(true);
    expect(existsSync(paths.integrations_installation_marker_path)).toBe(false);
  });

  it('rejects an integration database that differs from its installation marker', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    const originalFingerprint = authorityRuntimeFingerprint(
      resolveAuthorityServeConfig(config),
    );
    const marker = JSON.parse(
      readFileSync(paths.integrations_installation_marker_path, 'utf8'),
    ) as Record<string, unknown>;
    marker.control_plane_id = 'ocp_00000000-0000-4000-8000-000000000000';
    writeFileSync(
      paths.integrations_installation_marker_path,
      `${JSON.stringify(marker)}\n`,
    );
    expect(
      authorityRuntimeFingerprint(resolveAuthorityServeConfig(config)),
    ).not.toBe(originalFingerprint);

    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow('authority installation anchor differ');
    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow('authority installation anchor differ');
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
    await expect(
      installAuthorityIntegrations(fixture.configPath),
    ).rejects.toThrow('authority installation anchor differ');
  });

  it('rejects integration state pinned to a different organization', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const paths = authorityStatePaths(fixture.stateDirectory);
    unlinkSync(paths.integrations_database_path);
    initializeOrganizationControlDatabase(paths.integrations_database_path, {
      organization_id: 'org_different',
      authority_id: config.authority.authority_id,
      authority_descriptor_sha256: config.authority.authority_pin_sha256,
      created_at: new Date().toISOString(),
    });

    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow(
      'organization integrations database identity differs from config',
    );
    const status = await inspectAuthorityStatus(fixture.configPath);
    expect(status).toMatchObject({ ok: false, initialized: false });
    expect(status.checks.at(-1)?.detail).toContain(
      'organization integrations database identity differs from config',
    );
    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow(
      'organization integrations database identity differs from config',
    );
    await expect(
      installAuthorityIntegrations(fixture.configPath),
    ).rejects.toThrow(
      'organization integrations database identity differs from config',
    );
  });

  it('refuses integration maintenance while the authority owns the state', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const runtime = await startOrganizationAuthority(
      resolveAuthorityServeConfig(config),
    );
    try {
      await expect(
        installAuthorityIntegrations(fixture.configPath),
      ).rejects.toThrow('already running for this state directory');
    } finally {
      await runtime.close();
    }
  });

  it('never adopts an empty replacement database while serving', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    unlinkSync(config.database_path);
    openAuthorityDatabase(config.database_path).close();

    await expect(
      startOrganizationAuthority(resolveAuthorityServeConfig(config)),
    ).rejects.toThrow('metadata');
    expect(() =>
      inspectAuthorityDatabaseReadOnly(config.database_path),
    ).toThrow('metadata is missing');
    expect(
      (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
    ).toBe(false);
  });

  it('releases runtime ownership when the configured listener cannot bind', async () => {
    const fixture = await initializedFixture();
    const blocker = createNetServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const config = readAuthorityRuntimeConfig(fixture.configPath);
      await expect(
        startOrganizationAuthority(resolveAuthorityServeConfig(config)),
      ).rejects.toThrow();
      expect(
        (await inspectAuthorityRuntimeLock(fixture.stateDirectory)).present,
      ).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('enforces an absolute listener status deadline', async () => {
    const fixture = await initializedFixture();
    const runtimeConfig = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const runtimeLock = await acquireAuthorityRuntimeLock(
      fixture.stateDirectory,
      authorityRuntimeFingerprint(runtimeConfig),
    );
    const intervals = new Set<NodeJS.Timeout>();
    const listener = createHttpServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{');
      const interval = setInterval(() => response.write(' '), 100);
      intervals.add(interval);
      response.once('close', () => {
        clearInterval(interval);
        intervals.delete(interval);
      });
    });
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(fixture.port, '127.0.0.1', resolve);
    });
    try {
      const started = Date.now();
      const report = await inspectAuthorityStatus(fixture.configPath);
      expect(Date.now() - started).toBeLessThan(3_500);
      expect(report).toMatchObject({
        ok: false,
        running: true,
        healthy: false,
      });
    } finally {
      for (const interval of intervals) clearInterval(interval);
      await runtimeLock.release();
      listener.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        listener.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it('serve preflight never recreates a missing signing identity', async () => {
    const fixture = await initializedFixture();
    const config = readAuthorityRuntimeConfig(fixture.configPath);
    const keyPath = join(
      config.signer.key_directory,
      'authority-development-key.v1.json',
    );
    unlinkSync(keyPath);
    await expect(
      inspectAuthorityServePreflight(fixture.configPath, config),
    ).rejects.toThrow('key file does not exist');
    expect(existsSync(keyPath)).toBe(false);
  });

  it('rejects unknown config fields and insecure config permissions', async () => {
    const fixture = await initializedFixture();
    const original = JSON.parse(
      readFileSync(fixture.configPath, 'utf8'),
    ) as Record<string, unknown>;
    writeFileSync(
      fixture.configPath,
      `${JSON.stringify({ ...original, inline_admin_token: 'forbidden' })}\n`,
      { mode: 0o600 },
    );
    expect(() => readAuthorityRuntimeConfig(fixture.configPath)).toThrow(
      'unexpected shape',
    );
    writeFileSync(fixture.configPath, `${JSON.stringify(original)}\n`);
    chmodSync(fixture.configPath, 0o644);
    expect(() => readAuthorityRuntimeConfig(fixture.configPath)).toThrow(
      '0600',
    );
  });

  it('validates and fingerprints an optional closed organization recording policy', async () => {
    const fixture = await initializedFixture();
    const original = JSON.parse(
      readFileSync(fixture.configPath, 'utf8'),
    ) as Record<string, unknown>;
    const absent = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    const absentFingerprint = authorityRuntimeFingerprint(absent);
    expect(absent.organization_recording_policy_v1).toBeUndefined();

    const policy = {
      schema_version: 1,
      kind: 'organization-recording-policy-v1',
      decision_processor_adapter_instance_id: 'decision-processor-primary',
      approval_surface_adapter_instance_id: 'slack-reactions-primary',
      presentation_mode: 'organization-member-readable-v1',
      policy_contract_sha256: organizationMemberReadablePolicyContractSha256(),
    } as const;
    writeFileSync(
      fixture.configPath,
      `${JSON.stringify({
        ...original,
        organization_recording_policy_v1: policy,
      })}\n`,
      { mode: 0o600 },
    );
    const configured = resolveAuthorityServeConfig(
      readAuthorityRuntimeConfig(fixture.configPath),
    );
    expect(configured.organization_recording_policy_v1).toEqual(policy);
    expect(authorityRuntimeFingerprint(configured)).not.toBe(absentFingerprint);
    expect(
      authorityRuntimeFingerprint({
        ...configured,
        organization_recording_policy_v1: undefined,
      }),
    ).toBe(absentFingerprint);
  });

  it('refuses malformed or mismatched organization recording policy mappings', async () => {
    const fixture = await initializedFixture();
    const original = JSON.parse(
      readFileSync(fixture.configPath, 'utf8'),
    ) as Record<string, unknown>;
    const validReviewerPolicy = {
      schema_version: 1,
      kind: 'organization-recording-policy-v1',
      decision_processor_adapter_instance_id: 'decision-processor-primary',
      approval_surface_adapter_instance_id: 'slack-reactions-primary',
      presentation_mode: 'restricted-reviewer-v1',
      policy_contract_sha256: reviewerPolicyContractSha256(),
    };
    for (const policy of [
      { ...validReviewerPolicy, unexpected: true },
      { ...validReviewerPolicy, schema_version: 2 },
      {
        ...validReviewerPolicy,
        decision_processor_adapter_instance_id: ' '.repeat(129),
      },
      {
        ...validReviewerPolicy,
        presentation_mode: 'organization-member-readable-v1',
      },
    ]) {
      writeFileSync(
        fixture.configPath,
        `${JSON.stringify({
          ...original,
          organization_recording_policy_v1: policy,
        })}\n`,
        { mode: 0o600 },
      );
      expect(() => readAuthorityRuntimeConfig(fixture.configPath)).toThrow(
        'organization_recording_policy_v1',
      );
    }
  });

  it('exposes init and stopped status through strict JSON CLI commands', async () => {
    const root = temporaryRoot();
    const configPath = join(root, 'authority.json');
    const stateDirectory = join(root, 'state');
    const port = await reserveLoopbackPort();
    const output: string[] = [];
    const errors: string[] = [];
    const io = {
      stdout: (value: string) => output.push(value),
      stderr: (value: string) => errors.push(value),
    };
    expect(
      await runOrganizationAuthorityCli(
        [
          'init-development',
          '--config',
          configPath,
          '--state-dir',
          stateDirectory,
          '--organization-name',
          'Example Company',
          '--port',
          String(port),
        ],
        {},
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(output.shift()!)).toMatchObject({
      kind: 'echo-organization-authority-development-initialization',
      created: true,
    });
    expect(
      await runOrganizationAuthorityCli(
        ['status', '--config', configPath],
        {},
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(output.shift()!)).toMatchObject({
      kind: 'echo-organization-authority-status',
      initialized: true,
      running: false,
    });
    expect(errors).toEqual([]);
  });
});

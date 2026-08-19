import { Buffer } from 'node:buffer';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ORGANIZATION_API_ADMIN_AUDIT_PATH,
  ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH,
  ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH,
  ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH,
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_PROXY_AUTH_SCHEME,
} from '@echo-brain/organization-api';
import {
  canonicalJson,
  p256KeyId,
  type Sha256Digest,
} from '@echo-brain/federation-protocol';
import { organizationAuthorityPinSha256 } from '@echo-brain/organization-protocol';
import type { OrganizationAuthorityDescriptorV1 } from '@echo-brain/organization-protocol';
import { inspectAuthorityDatabaseReadOnly } from '../src/adapters/persistence/sqlite/read-only-inspection.js';
import { SqliteOrganizationAuthorityRepository } from '../src/adapters/persistence/sqlite/sqlite-authority-repository.js';
import { OrganizationAuthorityAdminQueries } from '../src/application/admin-queries.js';
import type { StoredAuthorityMembership } from '../src/application/ports/authority-repository.js';
import {
  createOrganizationAuthorityHttpServer,
  ORGANIZATION_API_ADMIN_INTEGRATIONS_PATH,
} from '../src/presentation/http-server.js';
import { InMemoryAdminConsoleSessionStore } from '../src/presentation/admin-console/sessions.js';
import type { OrganizationAuthorityHttpApplication } from '../src/presentation/organization-authority-http-application.js';
import type { OrganizationIntegrationsHttpApplication } from '../src/presentation/organization-integrations-http-application.js';
import {
  AuthenticatedProxyClientIdentityResolver,
  TRUSTED_PROXY_AUTHORIZATION_HEADER,
  TRUSTED_PROXY_CLIENT_ID_HEADER,
} from '../src/presentation/trusted-proxy-client-identity.js';

const NOW = '2026-08-18T00:00:00.000Z';
const AUTHORITY_ID = 'oau_00000000-0000-4000-8000-000000000001';
const ORGANIZATION_ID = 'org_00000000-0000-4000-8000-000000000001';
const PRINCIPAL_ID = 'prn_00000000-0000-4000-8000-000000000001';
const MEMBERSHIP_ID = 'mem_00000000-0000-4000-8000-000000000001';
const SOURCE_ADAPTER_ID = 'sentinel-private-adapter';
const SOURCE_INSTANCE_ID = 'sentinel-private-instance';
const EXTERNAL_ID = 'sentinel-private-meeting';
const ADMIN_TOKEN = 'test-admin-token-with-at-least-32-bytes';
const PROXY_TOKEN = 'test-proxy-origin-token-with-at-least-32-bytes';
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function digest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}

function descriptor(): OrganizationAuthorityDescriptorV1 {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicBytes = pair.publicKey.export({ format: 'der', type: 'spki' });
  if (!Buffer.isBuffer(publicBytes)) throw new Error('test key export failed');
  return {
    schema_version: 1,
    kind: 'echo-organization-authority',
    authority_id: AUTHORITY_ID,
    organization_id: ORGANIZATION_ID,
    signing_key: {
      key_id: p256KeyId(publicBytes),
      algorithm: 'ecdsa-p256-sha256-der-low-s',
      public_key_spki_der_base64: publicBytes.toString('base64'),
    },
  };
}

function membership(): StoredAuthorityMembership {
  return {
    organization_id: ORGANIZATION_ID,
    principal_id: PRINCIPAL_ID,
    membership_id: MEMBERSHIP_ID,
    display_name: 'Sentinel Owner',
    membership_type: 'employee',
    status: 'active',
    provisioned_at: NOW,
    revoked_at: null,
    revocation_reason: null,
    admin_command_id: 'adm_00000000-0000-4000-8000-000000000001',
    admin_command_sha256: digest('f'),
  };
}

function proxyHeaders(): Record<string, string> {
  return {
    connection: 'close',
    [TRUSTED_PROXY_AUTHORIZATION_HEADER]:
      `${ORGANIZATION_API_PROXY_AUTH_SCHEME} ${PROXY_TOKEN}`,
    [TRUSTED_PROXY_CLIENT_ID_HEADER]: `cid_${createHash('sha256')
      .update('member-exclusion-admin-noninterference')
      .digest('base64url')}`,
  };
}

function application(
  descriptorValue: OrganizationAuthorityDescriptorV1,
  admin: OrganizationAuthorityAdminQueries,
): OrganizationAuthorityHttpApplication {
  type PageInput = { cursor?: string; limit?: number };
  return {
    descriptor: () => descriptorValue,
    adminOverview: () => admin.overview(),
    listMemberships: (input?: PageInput) => admin.memberships(input),
    listInstallations: (input?: PageInput) => admin.installations(input),
    listEnrollmentGrants: (input?: PageInput) =>
      admin.enrollmentGrants(input),
    listAudit: (input?: PageInput) => admin.audit(input),
  } as unknown as OrganizationAuthorityHttpApplication;
}

function integrations(): OrganizationIntegrationsHttpApplication {
  return {
    overview: () => ({
      identity_links: [],
      tool_connections: [],
      adapter_bindings: [],
      permission_grants: [],
      recent_audit: [],
    }),
  } as unknown as OrganizationIntegrationsHttpApplication;
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  const closed = once(server, 'close');
  server.close();
  await closed;
}

const ADMIN_PATHS = [
  ORGANIZATION_API_ADMIN_OVERVIEW_PATH,
  ORGANIZATION_API_ADMIN_MEMBERSHIPS_PATH,
  ORGANIZATION_API_ADMIN_INSTALLATIONS_PATH,
  ORGANIZATION_API_ADMIN_ENROLLMENT_GRANTS_PATH,
  ORGANIZATION_API_ADMIN_AUDIT_PATH,
  ORGANIZATION_API_ADMIN_INTEGRATIONS_PATH,
] as const;

async function adminJsonSurfaces(origin: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const path of ADMIN_PATHS) {
    const response = await fetch(`${origin}${path}`, {
      headers: {
        ...proxyHeaders(),
        authorization: `Bearer ${ADMIN_TOKEN}`,
      },
    });
    expect(response.status).toBe(200);
    result[path] = await response.text();
  }
  return result;
}

async function login(origin: string): Promise<string> {
  const response = await fetch(`${origin}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      ...proxyHeaders(),
      origin: origin.replace(/^http:/, 'https:'),
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams({ credential: ADMIN_TOKEN }),
  });
  expect(response.status).toBe(303);
  return response.headers
    .getSetCookie()
    .map((value) => value.slice(0, value.indexOf(';')))
    .join('; ');
}

async function dashboard(origin: string, cookie: string): Promise<string> {
  const response = await fetch(`${origin}/admin`, {
    headers: { ...proxyHeaders(), cookie },
  });
  expect(response.status).toBe(200);
  return await response.text();
}

function assertSentinelAbsent(value: unknown): void {
  const serialized = typeof value === 'string' ? value : canonicalJson(value as never);
  expect(serialized).not.toContain(SOURCE_ADAPTER_ID);
  expect(serialized).not.toContain(SOURCE_INSTANCE_ID);
  expect(serialized).not.toContain(EXTERNAL_ID);
}

describe('member exclusion administrator noninterference', () => {
  it('leaves every generic query, JSON route, report, inspection, and dashboard byte-identical', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'echo-exclusion-sentinel-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'authority.sqlite');
    const descriptorValue = descriptor();
    const repository = new SqliteOrganizationAuthorityRepository(databasePath);
    repository.initialize({
      descriptor: descriptorValue,
      authority_pin_sha256: organizationAuthorityPinSha256(descriptorValue),
      organization_display_name: 'Sentinel Company',
      initialized_at: NOW,
    });
    repository.write(NOW, (transaction) => {
      transaction.insertMembership(membership());
    });
    const database = new Database(databasePath);
    database.pragma('foreign_keys = ON');
    database
      .prepare(
        `INSERT INTO authority_processing_source_owner_bindings (
           source_adapter_id, source_instance_id, organization_id,
           principal_id, membership_id, membership_type, bound_at
         ) VALUES (?, ?, ?, ?, ?, 'employee', ?)`,
      )
      .run(
        SOURCE_ADAPTER_ID,
        SOURCE_INSTANCE_ID,
        ORGANIZATION_ID,
        PRINCIPAL_ID,
        MEMBERSHIP_ID,
        NOW,
      );
    database.close();

    const admin = new OrganizationAuthorityAdminQueries(repository, {
      now: () => NOW,
    });
    const genericQueries = () => ({
      overview: admin.overview(),
      memberships: admin.memberships(),
      installations: admin.installations(),
      enrollment_grants: admin.enrollmentGrants(),
      audit: admin.audit(),
    });
    const server = createOrganizationAuthorityHttpServer({
      application: application(descriptorValue, admin),
      integrations: integrations(),
      adminAuthenticator: {
        authenticate: (header) => header === `Bearer ${ADMIN_TOKEN}`,
      },
      clientIdentityResolver: new AuthenticatedProxyClientIdentityResolver(
        PROXY_TOKEN,
      ),
      adminConsole: {
        sessions: new InMemoryAdminConsoleSessionStore({
          session_ttl_ms: 60_000,
          maximum_sessions: 10,
        }),
      },
    });
    const origin = await listen(server);
    try {
      const cookie = await login(origin);
      const before = {
        queries: genericQueries(),
        http: await adminJsonSurfaces(origin),
        dashboard: await dashboard(origin, cookie),
        inspection: inspectAuthorityDatabaseReadOnly(databasePath),
      };

      const seed = new Database(databasePath);
      seed.pragma('foreign_keys = ON');
      seed
        .prepare(
          `INSERT INTO authority_processing_member_exclusions (
             organization_id, principal_id, membership_id, membership_type,
             source_adapter_id, source_instance_id, scope_kind, external_id,
             created_at
           ) VALUES (?, ?, ?, 'employee', ?, ?, 'meeting', ?, ?)`,
        )
        .run(
          ORGANIZATION_ID,
          PRINCIPAL_ID,
          MEMBERSHIP_ID,
          SOURCE_ADAPTER_ID,
          SOURCE_INSTANCE_ID,
          EXTERNAL_ID,
          NOW,
        );
      seed.close();
      repository.write(NOW, (transaction) => {
        transaction.appendMemberExclusionReadAudit({
          actor_kind: 'admin_break_glass',
          actor_binding_sha256: digest('a'),
          request_sha256: digest('b'),
          response_bytes: Buffer.from(
            canonicalJson({
              source_adapter_id: SOURCE_ADAPTER_ID,
              source_instance_id: SOURCE_INSTANCE_ID,
              external_id: EXTERNAL_ID,
            }),
          ),
          result_count: 1,
          decision: 'allow',
          reason_code: 'break_glass_authorized',
        });
      });

      const after = {
        queries: genericQueries(),
        http: await adminJsonSurfaces(origin),
        dashboard: await dashboard(origin, cookie),
        inspection: inspectAuthorityDatabaseReadOnly(databasePath),
      };
      expect(after).toEqual(before);
      assertSentinelAbsent(after);
      expect(after.inspection.tables).toContain(
        'authority_processing_member_exclusions',
      );
      expect(after.inspection.tables).toContain(
        'authority_member_exclusion_read_audit',
      );
    } finally {
      await close(server);
      repository.close();
    }
  });
});
